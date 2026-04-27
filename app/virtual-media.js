'use strict';

const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');
const { once } = require('events');
const { fileURLToPath } = require('url');
const { negotiateConnection, DeviceType } = require('ilo-protocol/vm/handshake');
const { VirtualDevice } = require('ilo-protocol/vm/scsi');

const CDROM_DEVICE = 'CDROM';

/**
 * Virtual media manager for iLO 4.
 *
 * This implementation uses the real iLO virtual-media socket protocol from
 * ilo-protocol instead of trying to hand iLO a localhost URL.
 */

class LocalCdromDevice extends VirtualDevice {
  constructor(session) {
    super();
    this.session = session;
    this.socket = null;
    this.startPromise = null;
  }

  attachSocket(socket) {
    this.socket = socket;
  }

  async start() {
    if (this.startPromise) {
      return this.startPromise;
    }

    if (!this.socket) {
      throw new Error('Virtual media socket is not attached');
    }

    this.startPromise = (async () => {
      // Prime the SCSI state so iLO can query capacity and readiness.
      await this.receive(Buffer.alloc(0));

      void (async () => {
        try {
          for await (const chunk of this.socket) {
            await this.receive(chunk);
          }

          if (!this.session.closed) {
            this.session.handleSocketClosed();
          }
        } catch (error) {
          if (!this.session.closed) {
            this.session.handleProtocolError(error);
          }
        }
      })();
    })();

    return this.startPromise;
  }

  send(data) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(data);
    }
  }

  mediaIsPresent() {
    return this.session.isMounted();
  }

  async mediaSize() {
    const handle = this.session.fileHandle;
    if (!handle) {
      return 0;
    }

    try {
      const stat = await handle.stat();
      return stat.size;
    } catch (error) {
      console.error(`Virtual media size check failed: ${error.message}`);
      return 0;
    }
  }

  async mediaRead(buffer, pos) {
    const handle = this.session.fileHandle;
    if (!handle) {
      return true;
    }

    try {
      const result = await handle.read(buffer, 0, buffer.length, pos);
      return result.bytesRead === 0;
    } catch (error) {
      console.error(`Virtual media read failed: ${error.message}`);
      return true;
    }
  }

  notifyMediaEject() {
    void this.session.detachMedia('iLO ejected the media');
  }

  notifyMediaRemoval(prevented) {
    if (prevented) {
      console.log('Virtual media removal prevented by iLO');
    }
  }
}

class VirtualMediaSession {
  constructor(manager, filePath, deviceIndex) {
    this.manager = manager;
    this.filePath = filePath;
    this.fileName = path.basename(filePath);
    this.deviceIndex = deviceIndex;
    this.fileHandle = null;
    this.socket = null;
    this.device = new LocalCdromDevice(this);
    this.mounted = true;
    this.closed = false;
    this.connecting = false;
    this.protocolError = null;
  }

  isMounted() {
    return this.mounted && !this.closed;
  }

  async connect() {
    if (this.connecting) {
      return;
    }

    const host = this.manager.getVirtualMediaHost();
    if (!host) {
      throw new Error('Unable to determine the iLO host for virtual media');
    }

    if (!this.manager.client.sessionKey) {
      throw new Error('You must log in before mounting virtual media');
    }

    if (!this.manager.rcInfo) {
      throw new Error('Remote console information is not available yet');
    }

    this.connecting = true;
    try {
      const keys = await this.manager.getVirtualMediaKeys();
      let lastError = null;

      for (const keyInfo of keys) {
        try {
          await this.connectWithKey(host, keyInfo);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          console.warn(`Virtual media handshake failed with ${keyInfo.label}: ${error.message}`);
        }
      }

      if (lastError) {
        throw lastError;
      }

      this.device.attachSocket(this.socket);
      await this.device.start();
      console.log(`Virtual media session established for ${this.fileName}`);
    } finally {
      this.connecting = false;
    }
  }

  async connectWithKey(host, keyInfo) {
    console.log(
      `Connecting virtual media session for ${this.fileName} to ${host}:${this.manager.rcInfo.vmPort} ` +
        `using ${keyInfo.label}`
    );

    const socket = net.connect({ host, port: this.manager.rcInfo.vmPort });
    socket.setNoDelay(true);

    try {
      await this.manager.withTimeout(once(socket, 'connect'), 7000, 'Timed out connecting to iLO virtual media port');
      const vmVersion = await this.manager.withTimeout(
        negotiateConnection(socket, keyInfo.key, this.manager.rcInfo, {
          deviceType: DeviceType.CDROM,
          targetIsDevice: false,
        }),
        7000,
        'Timed out during iLO virtual media handshake'
      );

      this.socket = socket;
      console.log(`Connected to virtual media protocol ${vmVersion.join('.')} with ${keyInfo.label}`);
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  async detachMedia(reason = 'virtual media detached') {
    if (!this.mounted) {
      return;
    }

    this.mounted = false;
    console.log(`Virtual media detached: ${reason}`);

    const handle = this.fileHandle;
    this.fileHandle = null;
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        console.warn(`Failed to close virtual media file: ${error.message}`);
      }
    }
  }

  async destroy(reason = 'virtual media session closed') {
    if (this.closed) {
      return;
    }

    this.closed = true;
    await this.detachMedia(reason);

    if (this.device) {
      try {
        this.device.sendDisconnect();
      } catch (_error) {}
    }

    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.end();
      } catch (_error) {}
    }

    this.socket = null;

    this.manager.clearSession(this);
  }

  handleSocketClosed() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.socket = null;
    void this.detachMedia('iLO closed the virtual media connection');
    this.manager.clearSession(this);
  }

  handleProtocolError(error) {
    if (this.closed) {
      return;
    }

    const message = error && error.message ? error.message : String(error);
    this.protocolError = error;
    console.error(`Virtual media protocol error: ${message}`);
    void this.destroy(`virtual media protocol error: ${message}`);
  }
}

class VirtualMediaManager {
  constructor(client, host = null, options = {}) {
    this.client = client;
    this.host = host;
    this.username = options.username || null;
    this.password = options.password || null;
    this.mediaDir = process.env.ILO_MEDIA_DIR || '/opt/docker-ilo4/media';
    this.sessionInfo = null;
    this.rcInfo = null;
    this.currentSession = null;
  }

  async fetchVmStatus() {
    if (!this.client || typeof this.client.getVmStatus !== 'function') {
      return null;
    }

    try {
      return await this.client.getVmStatus();
    } catch (error) {
      console.warn(`Unable to read virtual media status from iLO: ${error.message}`);
      return null;
    }
  }

  setRemoteConsoleInfo(rcInfo) {
    this.rcInfo = rcInfo;
  }

  setSessionInfo(sessionInfo) {
    this.sessionInfo = sessionInfo;
  }

  withTimeout(promise, timeoutMs, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  normalizeFlag(value) {
    return value === 1 || value === '1' || value === true;
  }

  getDeviceName(_deviceIndex = 1) {
    // The GUI only mounts ISO images, so always target the virtual CD-ROM.
    return CDROM_DEVICE;
  }

  getVmStatusOption(vmStatus, deviceIndex = 1) {
    if (!vmStatus || !Array.isArray(vmStatus.options)) {
      return null;
    }

    const deviceName = this.getDeviceName(deviceIndex);
    const matchingDevice = vmStatus.options.find(
      (option) => String(option.device || '').toUpperCase() === deviceName
    );

    if (matchingDevice) {
      return matchingDevice;
    }

    return vmStatus.options[deviceIndex - 1] || vmStatus.options[0] || null;
  }

  isVmOptionActive(option) {
    if (!option) {
      return false;
    }

    return (
      this.normalizeFlag(option.image_inserted) ||
      this.normalizeFlag(option.vm_connected) ||
      this.normalizeFlag(option.vm_url_connected)
    );
  }

  normalizeVmOption(option, deviceIndex = 1, legacyBios = 0) {
    if (!option) {
      return null;
    }

    return {
      ...option,
      image_inserted: this.normalizeFlag(option.image_inserted) ? 1 : 0,
      vm_url_connected: this.normalizeFlag(option.vm_url_connected) ? 1 : 0,
      vm_connected: this.normalizeFlag(option.vm_connected) ? 1 : 0,
      write_protect_flag: this.normalizeFlag(option.write_protect_flag) ? 1 : 0,
      device: option.device || this.getDeviceName(deviceIndex),
      deviceIndex,
      legacy_bios: legacyBios,
    };
  }

  escapeXml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  async requestIloText(pathname) {
    const baseUrl = this.client && this.client.base ? new URL(this.client.base) : null;
    if (!baseUrl) {
      throw new Error('Unable to determine the iLO base URL');
    }

    return new Promise((resolve, reject) => {
      const headers = {};

      if (this.client && this.client.sessionKey) {
        headers.Cookie = `sessionKey=${this.client.sessionKey.toString('hex')}`;
      }

      const request = https.request(
        {
          protocol: baseUrl.protocol,
          hostname: baseUrl.hostname,
          port: baseUrl.port || 443,
          path: pathname,
          method: 'GET',
          rejectUnauthorized: false,
          headers,
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (response.statusCode < 200 || response.statusCode >= 300) {
              reject(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 120)}`));
              return;
            }
            resolve(body);
          });
        }
      );

      request.setTimeout(7000, () => request.destroy(new Error(`Timed out reading ${pathname} from iLO`)));
      request.on('error', reject);
      request.end();
    });
  }

  extractInfo0Keys(pageBody) {
    const keys = [];

    const addHex = (label, hexValue) => {
      if (!/^[0-9a-fA-F]{32}$/.test(hexValue)) {
        return;
      }

      keys.push({
        label,
        key: Buffer.from(hexValue, 'hex'),
      });
    };

    for (const match of String(pageBody).matchAll(/INFO0\\?=\\?"?([^"\r\n<]+)/g)) {
      const rawValue = match[1].replace(/\\$/, '');

      for (const hexMatch of rawValue.matchAll(/[0-9a-fA-F]{32}/g)) {
        addHex('Java IRC INFO0 key', hexMatch[0]);
      }

      let decodedValue = '';
      try {
        decodedValue = Buffer.from(rawValue, 'base64').toString('utf8');
      } catch (_error) {}

      for (const hexMatch of decodedValue.matchAll(/[0-9a-fA-F]{32}/g)) {
        addHex('Java IRC decoded INFO0 key', hexMatch[0]);
      }
    }

    return keys;
  }

  async getVirtualMediaKeys() {
    const keys = [];
    const seen = new Set();

    const addKey = (label, key) => {
      if (!key) {
        return;
      }

      const buffer = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
      if (buffer.length !== 16) {
        return;
      }

      const keyHex = buffer.toString('hex');
      if (seen.has(keyHex)) {
        return;
      }

      seen.add(keyHex);
      keys.push({ label, key: buffer });
    };

    addKey('REST login session key', this.client && this.client.sessionKey);

    if (this.rcInfo) {
      addKey('remote console VM key', this.rcInfo.vmKey);
      addKey('remote console command key', this.rcInfo.cmdEncKey);
    }

    try {
      const javaIrcPage = await this.requestIloText('/html/java_irc.html');
      for (const keyInfo of this.extractInfo0Keys(javaIrcPage)) {
        addKey(keyInfo.label, keyInfo.key);
      }
    } catch (error) {
      console.warn(`Unable to read Java IRC launch keys for virtual media: ${error.message}`);
    }

    if (keys.length === 0) {
      throw new Error('No virtual media handshake keys are available');
    }

    return keys;
  }

  async sendRibcl(xmlBody, options = {}) {
    if (!this.username || !this.password) {
      throw new Error('iLO credentials are not available for virtual media control');
    }

    const baseUrl = this.client && this.client.base ? new URL(this.client.base) : null;
    if (!baseUrl) {
      throw new Error('Unable to determine the iLO base URL');
    }

    const blockName = options.blockName || 'RIB_INFO';
    const mode = options.mode || 'write';

    const requestBody =
      '<?xml version="1.0"?>\r\n' +
      '<RIBCL VERSION="2.0">\r\n' +
      `<LOGIN USER_LOGIN="${this.escapeXml(this.username)}" PASSWORD="${this.escapeXml(this.password)}">\r\n` +
      `<${blockName} MODE="${mode}">\r\n` +
      xmlBody +
      `\r\n</${blockName}>\r\n` +
      '</LOGIN>\r\n' +
      '</RIBCL>\r\n';

    const responseBody = await new Promise((resolve, reject) => {
      const headers = {
        'Content-Type': 'text/xml',
        'Content-Length': Buffer.byteLength(requestBody),
      };

      if (this.client && this.client.sessionKey) {
        headers.Cookie = `sessionKey=${this.client.sessionKey.toString('hex')}`;
      }

      const request = https.request(
        {
          protocol: baseUrl.protocol,
          hostname: baseUrl.hostname,
          port: baseUrl.port || 443,
          path: '/ribcl',
          method: 'POST',
          rejectUnauthorized: false,
          headers,
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
        }
      );

      request.setTimeout(7000, () => request.destroy(new Error('Timed out waiting for iLO RIBCL response')));
      request.on('error', reject);
      request.end(requestBody);
    });

    const responseMatches = Array.from(responseBody.matchAll(/<RESPONSE\b([^>]*)>/gi));

    if (responseMatches.length === 0) {
      throw new Error(`Unable to parse RIBCL response: ${responseBody.slice(0, 200)}`);
    }

    for (const match of responseMatches) {
      const attrs = match[1];
      const statusMatch = /STATUS=["']([^"']+)["']/i.exec(attrs);
      const messageMatch = /(?:MESSAGE|MSG)=["']([^"']*)["']/i.exec(attrs);
      const status = statusMatch ? statusMatch[1] : null;
      const message = messageMatch ? messageMatch[1] : 'Unknown RIBCL response';

      if (status && status !== '0x0000') {
        throw new Error(`iLO RIBCL error ${status}: ${message}`);
      }
    }

    return responseBody;
  }

  async setOneTimeBoot(bootType = 'CDROM') {
    await this.sendRibcl(
      `<SET_ONE_TIME_BOOT value="${this.escapeXml(bootType)}"/>`,
      { blockName: 'SERVER_INFO', mode: 'write' }
    );
    console.log(`One-time boot set to ${bootType}`);
  }

  async connectVirtualMedia(deviceIndex = 1) {
    await this.sendRibcl(
      `<SET_VM_STATUS DEVICE="${this.getDeviceName(deviceIndex)}">\r\n` +
        `<VM_BOOT_OPTION VALUE="CONNECT"/>\r\n` +
        `<VM_WRITE_PROTECT VALUE="YES"/>\r\n` +
        `</SET_VM_STATUS>`
    );
    console.log(`Virtual media connected for device ${deviceIndex}`);
  }

  async disconnectVirtualMedia(deviceIndex = 1) {
    await this.sendRibcl(
      `<SET_VM_STATUS DEVICE="${this.getDeviceName(deviceIndex)}">\r\n` +
        `<VM_BOOT_OPTION VALUE="DISCONNECT"/>\r\n` +
        `</SET_VM_STATUS>`
    );
    console.log(`Virtual media disconnected for device ${deviceIndex}`);
  }

  getVirtualMediaHost() {
    if (this.host) {
      return this.host;
    }

    if (this.client && typeof this.client.base === 'string' && this.client.base) {
      try {
        return new URL(this.client.base).hostname;
      } catch (_error) {}
    }

    return null;
  }

  clearSession(session) {
    if (this.currentSession === session) {
      this.currentSession = null;
    }
  }

  async closeCurrentSession(reason = 'previous virtual media session replaced') {
    const session = this.currentSession;
    if (!session) {
      return false;
    }

    this.currentSession = null;
    await session.destroy(reason);
    return true;
  }

  async getMediaDevices() {
    const vmStatus = await this.fetchVmStatus();
    if (vmStatus && Array.isArray(vmStatus.options)) {
      return vmStatus.options.map((option, index) => ({
        ...option,
        deviceIndex: index + 1,
      }));
    }

    if (!this.rcInfo) {
      return [];
    }

    return [
      {
        device: CDROM_DEVICE,
        deviceIndex: 1,
        vmPort: this.rcInfo.vmPort,
      },
    ];
  }

  async getDeviceStatus(deviceIndex = 1) {
    const session = this.currentSession;
    if (session && session.deviceIndex === deviceIndex) {
      const mounted = session.isMounted();
      const connected = Boolean(session.socket && !session.socket.destroyed);

      return {
        device: deviceIndex,
        image_inserted: mounted ? 1 : 0,
        image_url: mounted ? session.filePath : '',
        image_url_file: mounted ? session.fileName : '',
        vm_url_connected: connected ? 1 : 0,
        vm_connected: connected ? 1 : 0,
        write_protect_flag: 1,
        legacy_bios: 0,
      };
    }

    const vmStatus = await this.fetchVmStatus();
    if (vmStatus && Array.isArray(vmStatus.options)) {
      const option = this.getVmStatusOption(vmStatus, deviceIndex);
      const status = this.normalizeVmOption(option, deviceIndex, vmStatus.legacy_bios);
      if (status) {
        return status;
      }
    }

    return {
      device: this.getDeviceName(deviceIndex),
      deviceIndex,
      image_inserted: 0,
      image_url: '',
      image_url_file: '',
      vm_url_connected: 0,
      vm_connected: 0,
      write_protect_flag: 1,
      legacy_bios: 0,
    };
  }

  async isMediaMounted(deviceIndex = 1) {
    const status = await this.getDeviceStatus(deviceIndex);
    return this.isVmOptionActive(status);
  }

  async getMountedImage(deviceIndex = 1) {
    const status = await this.getDeviceStatus(deviceIndex);
    if (this.isVmOptionActive(status)) {
      return status.image_url_file || status.image_url || null;
    }
    return null;
  }

  async waitForInserted(deviceIndex = 1, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = null;
    let sawVmStatus = false;

    while (Date.now() < deadline) {
      const vmStatus = await this.fetchVmStatus();
      if (vmStatus && Array.isArray(vmStatus.options)) {
        sawVmStatus = true;
        const option = this.getVmStatusOption(vmStatus, deviceIndex);
        if (option) {
          lastStatus = option;
          if (this.isVmOptionActive(option)) {
            return option;
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (sawVmStatus) {
      console.warn(
        `iLO REST status did not mark the virtual CD-ROM active after connecting` +
          (lastStatus ? ` (last status: ${JSON.stringify(lastStatus)})` : '') +
          `. Keeping the socket session mounted because the SCSI handshake succeeded.`
      );
      return lastStatus;
    }

    return null;
  }

  async mountIso(mediaPath, deviceIndex = 1, _bootable = true) {
    return this.insertLocalMedia(mediaPath, deviceIndex);
  }

  async insertMedia(mediaPath, deviceIndex = 1) {
    return this.insertLocalMedia(mediaPath, deviceIndex);
  }

  async insertLocalMedia(filePath, deviceIndex = 1) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('A local media path is required');
    }

    if (/^https?:\/\//i.test(filePath)) {
      throw new Error('Remote URLs are not supported by the virtual media transport. Select a local ISO file instead.');
    }

    let resolvedPath = filePath;
    if (/^file:\/\//i.test(filePath)) {
      resolvedPath = fileURLToPath(new URL(filePath));
    } else {
      resolvedPath = path.resolve(filePath);
    }

    let stat;
    try {
      stat = await fs.promises.stat(resolvedPath);
    } catch (error) {
      throw new Error(`Unable to read virtual media file: ${error.message}`);
    }

    if (!stat.isFile()) {
      throw new Error(`Virtual media path is not a file: ${filePath}`);
    }

    if (!this.rcInfo) {
      throw new Error('Remote console information is not available yet');
    }

    if (this.sessionInfo && Number(this.sessionInfo.virtual_media_priv) !== 1) {
      throw new Error('This iLO account does not have virtual media privilege enabled');
    }

    console.log(`Preparing virtual CD-ROM mount for ${path.basename(resolvedPath)} (${stat.size} bytes)`);
    await this.closeCurrentSession('replacing current virtual media');

    const session = new VirtualMediaSession(this, resolvedPath, deviceIndex);
    let bootArmed = false;
    let ribclConnected = false;
    try {
      session.fileHandle = await fs.promises.open(resolvedPath, 'r');
      await session.connect();
      this.currentSession = session;

      try {
        await this.connectVirtualMedia(deviceIndex);
        ribclConnected = true;
      } catch (error) {
        console.warn(`Unable to send iLO virtual media CONNECT command: ${error.message}`);
      }

      try {
        // Keep the next server boot pointed at the mounted ISO so we do not
        // depend on iLO refreshing the boot menu in place.
        await this.setOneTimeBoot('CDROM');
        bootArmed = true;
      } catch (error) {
        console.warn(`Unable to arm virtual media for the next boot: ${error.message}`);
      }
      await this.waitForInserted(deviceIndex);
      console.log(`Virtual media mounted: ${session.fileName}`);
      const status = await this.getDeviceStatus(deviceIndex);
      status.bootArmed = bootArmed;
      status.ribclConnected = ribclConnected;
      return status;
    } catch (error) {
      if (this.currentSession === session) {
        this.currentSession = null;
      }
      if (bootArmed) {
        try {
          await this.setOneTimeBoot('NORMAL');
        } catch (clearError) {
          console.warn(`Unable to clear one-time boot override after failure: ${clearError.message}`);
        }
      }
      await session.destroy('failed to mount virtual media');
      throw new Error(`Failed to mount virtual media: ${error.message}`);
    }
  }

  async unmountMedia(deviceIndex = 1) {
    const session = this.currentSession;
    if (!session || session.deviceIndex !== deviceIndex) {
      return false;
    }

    this.currentSession = null;
    try {
      await this.disconnectVirtualMedia(deviceIndex);
    } catch (error) {
      console.warn(`Virtual media disconnect warning: ${error.message}`);
    }
    try {
      // Clear any boot override so unmount behaves like a clean detach.
      await this.setOneTimeBoot('NORMAL');
    } catch (error) {
      console.warn(`Unable to clear one-time boot override: ${error.message}`);
    }
    await session.destroy('virtual media unmounted');
    console.log(`Virtual media unmounted from device ${deviceIndex}`);
    return true;
  }

  async setBootOrder() {
    throw new Error('Boot order control is not implemented by the virtual media transport');
  }
}

module.exports = VirtualMediaManager;

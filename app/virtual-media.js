'use strict';

const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');
const { once } = require('events');
const { fileURLToPath } = require('url');
const { negotiateConnection, DeviceType } = require('ilo-protocol/vm/handshake');
const { VirtualDevice } = require('ilo-protocol/vm/scsi');

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
      console.log(`Connecting virtual media session for ${this.fileName} to ${host}:${this.manager.rcInfo.vmPort}`);
      this.socket = net.connect({ host, port: this.manager.rcInfo.vmPort });
      this.socket.setNoDelay(true);
      await once(this.socket, 'connect');

      await negotiateConnection(this.socket, this.manager.client.sessionKey, this.manager.rcInfo, {
        deviceType: DeviceType.CDROM,
        targetIsDevice: false,
      });

      this.device.attachSocket(this.socket);
      await this.device.start();
      console.log(`Virtual media session established for ${this.fileName}`);
    } finally {
      this.connecting = false;
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

  escapeXml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
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

      request.on('error', reject);
      request.end(requestBody);
    });

    const statusMatch = /<RESPONSE\b[^>]*STATUS=["']([^"']+)["']/i.exec(responseBody);
    const messageMatch = /<RESPONSE\b[^>]*(?:MESSAGE|MSG)=["']([^"']*)["']/i.exec(responseBody);
    const status = statusMatch ? statusMatch[1] : null;
    const message = messageMatch ? messageMatch[1] : 'Unknown RIBCL response';

    if (status && status !== '0x0000') {
      throw new Error(`iLO RIBCL error ${status}: ${message}`);
    }

    if (!statusMatch) {
      throw new Error(`Unable to parse RIBCL response: ${responseBody.slice(0, 200)}`);
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
      `<SET_VM_STATUS DEVICE="CDROM">\r\n` +
        `<VM_BOOT_OPTION VALUE="CONNECT"/>\r\n` +
        `<VM_WRITE_PROTECT VALUE="YES"/>\r\n` +
        `</SET_VM_STATUS>`
    );
    console.log(`Virtual media connected for device ${deviceIndex}`);
  }

  async disconnectVirtualMedia(deviceIndex = 1) {
    await this.sendRibcl(
      `<SET_VM_STATUS DEVICE="CDROM">\r\n` +
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
        device: 'CDROM',
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
      const option = vmStatus.options[deviceIndex - 1] || vmStatus.options[0];
      if (option) {
        return {
          ...option,
          image_inserted: Number(option.image_inserted) === 1 ? 1 : 0,
          device: deviceIndex,
          legacy_bios: vmStatus.legacy_bios,
        };
      }
    }

    return {
      device: deviceIndex,
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
    return Boolean(status && Number(status.image_inserted) === 1);
  }

  async getMountedImage(deviceIndex = 1) {
    const status = await this.getDeviceStatus(deviceIndex);
    if (status && Number(status.image_inserted) === 1) {
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
        const option = vmStatus.options[deviceIndex - 1] || vmStatus.options[0];
        if (option) {
          lastStatus = option;
          if (Number(option.image_inserted) === 1) {
            return option;
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (sawVmStatus) {
      throw new Error(
        `iLO did not report the virtual media image as inserted after connecting` +
          (lastStatus ? ` (last status: ${JSON.stringify(lastStatus)})` : '')
      );
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

    await this.closeCurrentSession('replacing current virtual media');

    const session = new VirtualMediaSession(this, resolvedPath, deviceIndex);
    let bootArmed = false;
    try {
      session.fileHandle = await fs.promises.open(resolvedPath, 'r');
      await session.connect();
      await this.connectVirtualMedia(deviceIndex);
      try {
        // Keep the next server boot pointed at the mounted ISO so we do not
        // depend on iLO refreshing the boot menu in place.
        await this.setOneTimeBoot('CDROM');
        bootArmed = true;
      } catch (error) {
        console.warn(`Unable to arm virtual media for the next boot: ${error.message}`);
      }
      await this.waitForInserted(deviceIndex);
      this.currentSession = session;
      console.log(`Virtual media mounted: ${session.fileName}`);
      const status = await this.getDeviceStatus(deviceIndex);
      status.bootArmed = bootArmed;
      return status;
    } catch (error) {
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

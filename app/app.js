#!/usr/bin/env node

'use strict';

const { type: osType } = require('os');
const net = require('net');
const { once } = require('events');

const { RestAPIClient } = require('ilo-protocol/rest');
const { negotiateConnection } = require('ilo-protocol/rc/handshake');
const { DvcEncryption, Telnet } = require('ilo-protocol/rc/telnet');
const { DvcDecoder, MessageChannel } = require('ilo-protocol/rc/video');
const {
  Command,
  formatCommand,
  formatKeyboardCommand,
  formatMouseCommand,
  powerStatusCommands,
} = require('ilo-protocol/rc/command');

const gi = require('node-gtk');
const Gtk = gi.require('Gtk', '3.0');
const Gdk = gi.require('Gdk', '3.0');
const Cairo = gi.require('cairo', '2.0');

const linuxToHid = [
  0, 41, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 45, 46, 42, 43,
  20, 26, 8, 21, 23, 28, 24, 12, 18, 19, 47, 48, 40, 224, 4, 22,
  7, 9, 10, 11, 13, 14, 15, 51, 52, 53, 225, 49, 29, 27, 6, 25,
  5, 17, 16, 54, 55, 56, 229, 85, 226, 44, 57, 58, 59, 60, 61, 62,
  63, 64, 65, 66, 67, 83, 71, 95, 96, 97, 86, 92, 93, 94, 87, 89,
  90, 91, 98, 99, 0, 148, 100, 68, 69, 135, 146, 147, 138, 136, 139, 140,
  88, 228, 84, 70, 230, 0, 74, 82, 75, 80, 79, 77, 81, 78, 73, 76,
  0, 127, 129, 128, 102, 103, 0, 72, 0, 133, 144, 145, 137, 227, 231, 101,
  120, 121, 118, 122, 119, 124, 116, 125, 126, 123, 117, 0, 251, 0, 248, 0,
  0, 0, 0, 0, 0, 0, 240, 0, 249, 0, 0, 0, 0, 0, 241, 242,
  0, 236, 0, 235, 232, 234, 233, 0, 0, 0, 0, 0, 0, 250, 0, 0,
  247, 245, 246, 0, 0, 0, 0, 104, 105, 106, 107, 108, 109, 110, 111, 112,
  113, 114, 115,
];

function mapGdkKeycodeToHid(code) {
  const evdevCode = code - 8;
  if (!linuxToHid[evdevCode]) {
    return undefined;
  }
  return linuxToHid[evdevCode];
}

function normalizeConfig() {
  const rawHost = process.env.ILO_HOST;
  const username = process.env.ILO_USER;
  const password = process.env.ILO_PASSWORD;
  const busyPolicy = (process.env.ILO_BUSY_POLICY || 'share').toLowerCase();

  if (!rawHost || !username || !password) {
    throw new Error('ILO_HOST, ILO_USER and ILO_PASSWORD are required');
  }

  const url = /^https?:\/\//i.test(rawHost) ? new URL(rawHost) : new URL(`https://${rawHost}`);
  const apiPort = Number(process.env.ILO_PORT || url.port || 443);

  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error(`Invalid ILO_PORT: ${process.env.ILO_PORT}`);
  }

  if (!['share', 'seize', 'disconnect'].includes(busyPolicy)) {
    throw new Error(`Invalid ILO_BUSY_POLICY: ${busyPolicy}`);
  }

  return {
    baseUrl: `https://${url.hostname}:${apiPort}`,
    host: url.hostname,
    username,
    password,
    busyPolicy,
  };
}

function makePowerButton(label, payload, telnet) {
  const button = new Gtk.Button();
  button.label = safeGtkText(label);
  button.focusOnClick = false;
  button.on('clicked', () => telnet.sendDvc(payload));
  return button;
}

function logMessage(channel, data) {
  const channelName = MessageChannel[channel] || `UNKNOWN_${channel}`;
  console.log(`Message (${channelName}): ${JSON.stringify(data)}`);
}

function formatError(error) {
  if (!error) {
    return 'Unknown error';
  }

  if (error.response && error.response.statusCode) {
    return `HTTP ${error.response.statusCode}: ${error.message}`;
  }

  if (error.code) {
    return `${error.code}: ${error.message}`;
  }

  return error.message || String(error);
}

function safeGtkText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?');
}

async function main() {
  const config = normalizeConfig();
  const debugVideo = process.env.ILO_DEBUG_VIDEO === '1';

  if (osType() !== 'Linux') {
    console.warn('Keyboard input is tuned for Linux keycodes and may be inaccurate on other platforms.');
  }

  gi.startLoop();
  Gtk.init();

  const client = new RestAPIClient(config.baseUrl);
  await client.loginSession(config.username, config.password);

  const rcInfo = await client.getRcInfo();
  console.log(`Connected to ${config.host}. Protocol ${rcInfo.protocolVersion}. Features: ${Array.from(rcInfo.optionalFeatures).join(', ')}`);

  const rcSocket = net.connect({ host: config.host, port: rcInfo.rcPort });
  rcSocket.setNoDelay(true);
  await once(rcSocket, 'connect');
  await negotiateConnection(false, rcSocket, client.sessionKey, rcInfo, {
    negotiateBusy: async () => {
      if (config.busyPolicy === 'disconnect') {
        throw new Error('Remote console is already in use');
      }
      console.log(`Remote console busy, using policy: ${config.busyPolicy}`);
      return config.busyPolicy;
    },
  });

  const cmdSocket = net.connect({ host: config.host, port: rcInfo.rcPort });
  cmdSocket.setNoDelay(true);
  await once(cmdSocket, 'connect');
  await negotiateConnection(true, cmdSocket, client.sessionKey, rcInfo);

  let quitting = false;
  let screenSize;
  let surface;
  let surfaceContext;
  let blockImage;
  let renderedBlocks = 0;
  let resyncAttempts = 0;
  let resyncTimer;
  let noVideoCount = 0;
  let statusMessage = 'Connecting to iLO remote console...';

  const window = new Gtk.Window();
  window.title = safeGtkText(`iLO 4 Console - ${rcInfo.serverName || config.host}`);
  window.borderWidth = 8;

  const drawingArea = new Gtk.DrawingArea();
  drawingArea.canFocus = true;
  drawingArea.sensitive = true;
  drawingArea.addEvents(
    Gdk.EventMask.KEY_PRESS_MASK |
      Gdk.EventMask.KEY_RELEASE_MASK |
      Gdk.EventMask.BUTTON_PRESS_MASK |
      Gdk.EventMask.BUTTON_RELEASE_MASK |
      Gdk.EventMask.POINTER_MOTION_MASK
  );

  const statusLabel = new Gtk.Label();
  statusLabel.xalign = 0;
  statusLabel.justify = Gtk.Justification.LEFT;
  statusLabel.visible = true;
  statusLabel.label = safeGtkText(statusMessage);

  const updateStatus = (message) => {
    statusMessage = safeGtkText(message || '');
    statusLabel.label = statusMessage;
    statusLabel.visible = Boolean(statusMessage);
  };

  drawingArea.on('draw', (arg1, arg2) => {
    try {
      const context = arg1 && typeof arg1.setSourceSurface === 'function' ? arg1 : arg2;
      if (!context || typeof context.setSourceSurface !== 'function') {
        return false;
      }

      if (!surface) {
        context.setSourceRgb(0.96, 0.96, 0.96);
        context.paint();
        return false;
      }

      context.setSourceSurface(surface, 0, 0);
      context.paint();
      return false;
    } catch (error) {
      console.error(`Draw callback failed: ${formatError(error)}`);
      return false;
    }
  });

  const keysPressed = new Set();
  const sendKeys = () => {
    const hidCodes = Array.from(keysPressed).reverse();
    telnet.sendDvc(formatKeyboardCommand(hidCodes));
  };

  drawingArea.on('key-press-event', (event) => {
    const hidCode = mapGdkKeycodeToHid(event.hardwareKeycode);
    if (hidCode !== undefined) {
      keysPressed.delete(hidCode);
      keysPressed.add(hidCode);
      sendKeys();
    }
    return true;
  });

  drawingArea.on('key-release-event', (event) => {
    const hidCode = mapGdkKeycodeToHid(event.hardwareKeycode);
    if (hidCode !== undefined) {
      keysPressed.delete(hidCode);
      sendKeys();
    }
    return true;
  });

  let mousePosition = [0, 0];
  let buttonsPressed = 0;

  const sendMouse = () => {
    telnet.sendDvc(formatMouseCommand(mousePosition[0], mousePosition[1], buttonsPressed));
  };

  const updateMouseButtons = (event, pressed) => {
    let bit = 0;
    if (event.button === 1) {
      bit = 1 << 0;
    } else if (event.button === 3) {
      bit = 1 << 1;
    } else if (event.button === 2) {
      bit = 1 << 2;
    } else {
      return false;
    }

    if (pressed) {
      buttonsPressed |= bit;
    } else {
      buttonsPressed &= ~bit;
    }

    sendMouse();
    return true;
  };

  const mouseEvent = (event) => {
    if (event.type === Gdk.EventType.BUTTON_PRESS) {
      drawingArea.grabFocus();
      return updateMouseButtons(event, true);
    }

    if (event.type === Gdk.EventType.BUTTON_RELEASE) {
      return updateMouseButtons(event, false);
    }

    if (event.type === Gdk.EventType.MOTION_NOTIFY && screenSize) {
      mousePosition = [event.x / screenSize[0], event.y / screenSize[1]];
      sendMouse();
    }

    return true;
  };

  drawingArea.on('button-press-event', mouseEvent);
  drawingArea.on('button-release-event', mouseEvent);
  drawingArea.on('motion-notify-event', mouseEvent);

  const scheduleResync = (reason) => {
    if (resyncAttempts >= 3 || resyncTimer) {
      return;
    }

    resyncTimer = setTimeout(() => {
      resyncTimer = undefined;
      resyncAttempts += 1;
      console.log(`Requesting screen resync (${reason}, attempt ${resyncAttempts})`);
      updateStatus(`Connected to iLO, but host video is unavailable.\nRetrying video sync (${resyncAttempts}/3)...`);
      drawingArea.queueDraw();
      telnet.sendDvc(formatCommand(Command.REQUEST_RESYNC));
    }, 750);
  };

  const telnet = new (class extends Telnet {
    constructor(encKey) {
      super(encKey);
    }

    send(data) {
      rcSocket.write(data);
    }

    receiveDvc(value) {
      decoder.process(value);
    }
  })(Buffer.from(rcInfo.encKey, 'hex'));

  const decoder = new (class extends DvcDecoder {
    setVideoDecryption(encryptionMode) {
      console.log(`Video encryption: ${DvcEncryption[encryptionMode]}`);
      updateStatus('Connected to iLO. Waiting for host video...');
      drawingArea.queueDraw();
      telnet.setDvcWithEncryption(encryptionMode);
    }

    setFramerate(rate) {
      console.log(`Framerate: ${rate}`);
    }

    setPowerStatus(hasPower) {
      console.log(hasPower ? 'Power on' : 'Power off');
    }

    setInfo(licensed, flags) {
      console.log(`Licensed=${licensed} Flags=${flags}`);
    }

    setTsType(type) {
      console.log(`TS type: ${type}`);
    }

    printString(channel, data) {
      logMessage(channel, data);
    }

    noVideo() {
      console.log('No video stream available');
      noVideoCount += 1;
      screenSize = undefined;
      surface = undefined;
      surfaceContext = undefined;
      blockImage = undefined;

      if (noVideoCount >= 3) {
        updateStatus(
          'iLO reports: NO VIDEO\n' +
          'Common causes:\n' +
          '- no iLO Advanced license for OS-level graphics\n' +
          '- optional PCI/PCIe GPU installed\n' +
          '- embedded/onboard video disabled as primary in BIOS/RBSU'
        );
        console.log('Hint: repeated NO VIDEO usually means licensing or server video-path limitations, not a container rendering failure.');
      } else {
        updateStatus('Connected to iLO, but the server currently reports no video.\nWaiting for video stream...');
      }

      drawingArea.queueDraw();
      scheduleResync('no video');
    }

    seize() {
      console.log('This session was seized by another client');
    }

    ping() {
      telnet.sendDvc(formatCommand(Command.ACK));
    }

    requestResync() {
      console.log('Requesting screen resync');
      telnet.sendDvc(formatCommand(Command.REQUEST_RESYNC));
    }

    exitDvc() {
      console.log('Leaving DVC mode');
      telnet.exitDvc();
    }

    setScreenDimensions(width, height) {
      if (debugVideo) {
        console.log(`Screen dimensions set to ${width}x${height}`);
      }

      noVideoCount = 0;
      resyncAttempts = 0;
      updateStatus('');
      screenSize = [width, height];
      surface = window.window.createSimilarSurface(Cairo.Content.COLOR, width, height);
      surfaceContext = new Cairo.Context(surface);
      surfaceContext.setSourceRgb(0, 0, 0);
      surfaceContext.paint();
      drawingArea.setSizeRequest(width, height);
      blockImage = Cairo.ImageSurface.createForData(
        decoder.block,
        Cairo.Format.RGB24,
        decoder.blockWidth,
        decoder.blockHeight,
        decoder.blockWidth * 4
      );
      window.resize(Math.min(width + 24, 1600), Math.min(height + 110, 1200));
    }

    renderBlock(_block, x, y, width, height) {
      if (!surface) {
        return;
      }

      renderedBlocks += 1;
      if (debugVideo && renderedBlocks <= 10) {
        console.log(`Render block #${renderedBlocks} at ${x},${y} size ${width}x${height}`);
      }

      blockImage.markDirty();
      surfaceContext.setSourceSurface(blockImage, x, y);
      surfaceContext.paint();
      drawingArea.queueDrawArea(x, y, width, height);
    }

    clearScreen() {
      console.log('Clear screen');
      updateStatus('Video stream cleared by iLO.');
      drawingArea.queueDraw();
    }

    repaintScreen() {
      drawingArea.queueDraw();
    }

    invalidateScreen() {
      drawingArea.queueDraw();
      if (!surface) {
        scheduleResync('invalidate screen');
      }
    }
  })();

  const frame = new Gtk.Frame();
  frame.shadowType = Gtk.ShadowType.IN;
  frame.add(drawingArea);

  const frameBox = new Gtk.Box();
  frameBox.orientation = Gtk.Orientation.HORIZONTAL;
  frameBox.packStart(frame, true, false, 0);

  const powerButtons = new Gtk.Box();
  powerButtons.orientation = Gtk.Orientation.HORIZONTAL;
  powerButtons.spacing = 8;
  powerButtons.packStart(makePowerButton('Press Power', powerStatusCommands.MOMENTARY_PRESS, telnet), false, true, 0);
  powerButtons.packStart(makePowerButton('Hold Power', powerStatusCommands.PRESS_AND_HOLD, telnet), false, true, 0);
  powerButtons.packStart(makePowerButton('Power Cycle', powerStatusCommands.POWER_CYCLE, telnet), false, true, 0);
  powerButtons.packStart(makePowerButton('System Reset', powerStatusCommands.SYSTEM_RESET, telnet), false, true, 0);

  const container = new Gtk.Box();
  container.orientation = Gtk.Orientation.VERTICAL;
  container.spacing = 8;
  container.packStart(frameBox, true, false, 0);
  container.packStart(statusLabel, false, true, 0);
  container.packStart(powerButtons, false, true, 0);

  window.add(container);
  window.on('destroy', () => {
    quitting = true;
    try {
      rcSocket.end();
    } catch (_error) {}
    try {
      cmdSocket.end();
    } catch (_error) {}
    Gtk.mainQuit();
  });
  window.on('delete-event', () => false);

  window.showAll();
  if (typeof window.realize === 'function') {
    window.realize();
  }
  drawingArea.grabFocus();

  rcSocket.on('end', () => {
    if (!quitting) {
      console.error('Remote console socket disconnected');
      Gtk.mainQuit();
    }
  });

  rcSocket.on('data', (data) => {
    data.forEach((value) => telnet.receive(value));
  });

  rcSocket.on('error', (error) => {
    if (!quitting) {
      console.error(`Remote console error: ${error.message}`);
      Gtk.mainQuit();
    }
  });

  cmdSocket.on('error', (error) => {
    if (!quitting) {
      console.error(`Command session error: ${error.message}`);
    }
  });

  Gtk.main();
}

main().catch((error) => {
  console.error(`Unable to start iLO 4 client: ${formatError(error)}`);
  if (process.env.ILO_DEBUG_STACK === '1' && error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});

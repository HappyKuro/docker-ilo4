# Virtual Media Support

## Overview

The docker-ilo4 application can mount local ISO files through the iLO 4 virtual-media socket protocol provided by `ilo-protocol`. When you select an image in the GUI, the client opens a dedicated virtual-media session and streams the file directly to iLO as a virtual CD-ROM.

## Features

- Mount local ISO images from the file picker
- Unmount currently attached media
- Show the active image name in the status label
- Query whether a local virtual-media session is active

## Usage

### GUI Controls

The application includes a virtual media control panel with:

1. `Mount ISO` button: opens a file chooser and mounts the selected local ISO
2. `Unmount ISO` button: closes the active virtual media session
3. `Status Label`: displays the mounted image name

### API Methods

#### Initialize VirtualMediaManager

```javascript
const VirtualMediaManager = require('./virtual-media');
const vmManager = new VirtualMediaManager(client, config.host);
vmManager.setRemoteConsoleInfo(rcInfo);
```

#### Mount ISO Image

```javascript
await vmManager.insertLocalMedia('/path/to/image.iso', 1);
// mountIso() is kept as an alias for local files
await vmManager.mountIso('/path/to/image.iso', 1);
```

#### Unmount Media

```javascript
await vmManager.unmountMedia(1);
```

#### Check Status

```javascript
const isMounted = await vmManager.isMediaMounted(1);
const imagePath = await vmManager.getMountedImage(1);
```

## Requirements

- Valid iLO 4 credentials
- iLO 4 firmware with virtual media support
- An iLO account with virtual-media privilege enabled
- An active remote console session
- Access to the ISO file from inside the client environment
- By default the file chooser opens in `ILO_MEDIA_DIR` or `/opt/docker-ilo4/media`

## Notes

- Remote URLs are not supported by the current virtual media transport.
- Mounting the ISO now also arms the next boot for the virtual CD-ROM, and unmounting clears that override.
- No extra HTTP server or additional container port is required for virtual media.

## Error Handling

All virtual media operations include comprehensive error handling:

- Failed file access or protocol setup is logged to the console
- The socket/SCSI session is treated as the source of truth, because iLO REST status may report socket media with `vm_connected` instead of `image_inserted`
- User-friendly error messages are displayed in the status area
- Connection errors gracefully degrade functionality

## Future Enhancements

Potential improvements for virtual media support:

- Virtual floppy support
- Batch mounting workflows
- Better boot-order integration
- Media usage diagnostics

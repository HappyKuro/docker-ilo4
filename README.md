# docker-ilo4

Dockerized iLO 4 remote console with a browser-based GUI on port `5800` and raw VNC on port `5900`, inspired by [`docker-idrac6`](https://github.com/DomiStyle/docker-idrac6).

Instead of depending on HPE's old Java Web Start client, this image runs a native GTK client inside the container and exposes it through `noVNC`/VNC. The remote console protocol layer is provided by [`ilo-protocol`](https://github.com/mildsunrise/ilo-protocol), which documents support for iLO 4 `v2.55` and likely nearby firmware versions.

## Usage

Build the image:

```bash
docker build -t docker-ilo4 .
```

If you built the image via `docker compose`, make sure the tag is also `docker-ilo4` and not `docker-ilo4:local`.

For `docker compose`, the repository includes [`.env.example`](./.env.example). Create a local `.env` from it and adjust the values for your iLO host and account.

Run it:

```bash
docker run -d \
  --name docker-ilo4 \
  -p 5800:5800 \
  -p 5900:5900 \
  -e ILO_HOST=ilo4.example.org \
  -e ILO_USER=Administrator \
  -e ILO_PASSWORD=change-me \
  docker-ilo4
```

Then open:

- `http://localhost:5800` for the web UI
- `localhost:5900` for a VNC client

## Configuration

| Variable | Description | Required |
|---|---|---|
| `ILO_HOST` | Hostname or IP address of the iLO 4 interface. `https://` is optional. | Yes |
| `ILO_PORT` | HTTPS port used by the iLO web/API endpoint. Defaults to `443`. | No |
| `ILO_USER` | iLO username. | Yes |
| `ILO_PASSWORD` | iLO password. | Yes |
| `ILO_BUSY_POLICY` | What to do if another remote console session is already active: `share`, `seize`, or `disconnect`. Defaults to `share`. | No |
| `ILO_DEBUG_VIDEO` | Set to `1` to log screen size, first rendered blocks, and automatic resync attempts while debugging blank video. | No |
| `ILO_MEDIA_DIR` | Directory the virtual media file chooser opens in. Defaults to `/opt/docker-ilo4/media`. | No |

## Docker Compose

The included [`docker-compose.yml`](./docker-compose.yml) reads values from environment variables. The intended flow is:

- copy `.env.example` to `.env`
- edit `.env`
- then run:

```bash
docker compose up --build -d
```

You can also provide Docker secrets at:

- `/run/secrets/ilo_host`
- `/run/secrets/ilo_port`
- `/run/secrets/ilo_user`
- `/run/secrets/ilo_password`
- `/run/secrets/ilo_busy_policy`

For base GUI options like timezone, user/group ids, web auth, screen resolution, and VNC passwording, see the [`jlesage/baseimage-gui`](https://github.com/jlesage/docker-baseimage-gui) documentation.

## Notes

- This image is focused on the remote console, keyboard/mouse input, and basic power controls.
- Virtual media is available for local ISO files through the built-in iLO virtual-media session, and the app now explicitly tells iLO to connect the device so it shows up in boot options.
- The iLO account needs virtual-media privilege enabled for mounting to work.
- The client assumes Linux-style keycodes, matching the upstream example application.
- iLO licensing and network access rules still apply. The iLO remote console port returned by the API must be reachable from the container.
- The local [`media`](./media) directory is kept for convenience, so ISO images stored there are easy to pick from the file chooser, but it is still ignored by Git and Docker builds.

## Troubleshooting

- If the app connects but shows `NO VIDEO`, the container is working and the iLO itself is reporting that no video stream is available.
- Common causes are missing iLO Advanced licensing for full graphics console access, the server using an add-in GPU instead of the embedded video adapter, or onboard video not being selected as the primary display in BIOS/RBSU.
- You can enable `ILO_DEBUG_VIDEO=1` to log resync attempts and first video blocks while diagnosing blank output.

## Credits

- Concept and UX inspiration: [`DomiStyle/docker-idrac6`](https://github.com/DomiStyle/docker-idrac6)
- Protocol/client foundation: [`mildsunrise/ilo-protocol`](https://github.com/mildsunrise/ilo-protocol)

## License

This repository is provided under `AGPL-3.0-or-later`. See [`LICENSE`](./LICENSE).

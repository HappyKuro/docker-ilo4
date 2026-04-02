FROM node:16-bullseye AS build

WORKDIR /opt/docker-ilo4/app

COPY app/package.json ./package.json

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        git \
        gobject-introspection \
        libatk1.0-dev \
        libcairo2-dev \
        libgdk-pixbuf-2.0-dev \
        libgirepository1.0-dev \
        libgtk-3-dev \
        libpango1.0-dev \
        libxtst-dev \
        pkg-config \
        python3 && \
    npm install --omit=dev --unsafe-perm && \
    npm cache clean --force && \
    rm -rf /var/lib/apt/lists/*

COPY app/app.js ./app.js

FROM jlesage/baseimage-gui:debian-12-v4

ENV APP_NAME="iLO 4" \
    DEBIAN_FRONTEND=noninteractive \
    DISPLAY_WIDTH=1440 \
    DISPLAY_HEIGHT=1040 \
    LANG=C.UTF-8 \
    ILO_PORT=443 \
    ILO_BUSY_POLICY=share

WORKDIR /opt/docker-ilo4/app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        gir1.2-atk-1.0 \
        gir1.2-gdkpixbuf-2.0 \
        gir1.2-gtk-3.0 \
        gir1.2-pango-1.0 \
        libgirepository-1.0-1 \
        libgtk-3-0 \
        libharfbuzz-gobject0 \
        libxtst6 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/ /usr/local/
COPY --from=build /opt/docker-ilo4/app/ /opt/docker-ilo4/app/
COPY logo.png /logo.png
COPY startapp.sh /startapp.sh

RUN chmod +x /startapp.sh && \
    /opt/base/bin/install_app_icon.sh /logo.png && \
    rm -f /logo.png

#!/bin/sh

set -eu

read_secret() {
    var_name="$1"
    secret_path="$2"

    if [ -f "$secret_path" ]; then
        echo "Using Docker secret for $var_name"
        value="$(cat "$secret_path")"
        export "$var_name=$value"
    fi
}

read_secret ILO_HOST /run/secrets/ilo_host
read_secret ILO_PORT /run/secrets/ilo_port
read_secret ILO_USER /run/secrets/ilo_user
read_secret ILO_PASSWORD /run/secrets/ilo_password
read_secret ILO_BUSY_POLICY /run/secrets/ilo_busy_policy

: "${ILO_PORT:=443}"
: "${ILO_BUSY_POLICY:=share}"

case "$ILO_BUSY_POLICY" in
    share|seize|disconnect)
        ;;
    *)
        echo "Invalid ILO_BUSY_POLICY: $ILO_BUSY_POLICY"
        echo "Expected one of: share, seize, disconnect"
        sleep 2
        exit 1
        ;;
esac

if [ -z "${ILO_HOST:-}" ]; then
    echo "Please set ILO_HOST"
    sleep 2
    exit 1
fi

if [ -z "${ILO_USER:-}" ]; then
    echo "Please set ILO_USER"
    sleep 2
    exit 1
fi

if [ -z "${ILO_PASSWORD:-}" ]; then
    echo "Please set ILO_PASSWORD"
    sleep 2
    exit 1
fi

cd /opt/docker-ilo4/app
exec node /opt/docker-ilo4/app/app.js

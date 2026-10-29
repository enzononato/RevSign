# RevSign — imagem de backup: pg_dump -Fc cifrado com age, cópia SFTP/FTPS, retenção.
# O dump em texto puro nunca é gravado em disco nem enviado a lugar nenhum.
FROM postgres:17-alpine

# supercronic (e não busybox crond) porque a imagem roda sem root (UID 1001).
RUN apk add --no-cache rclone age tzdata supercronic \
    && adduser -D -u 1001 backup \
    && mkdir -p /backups /usr/local/lib/revsign \
    && chown backup /backups \
    && install -d -o backup /home/backup/.config/rclone \
    && install -o backup /dev/null /home/backup/.config/rclone/rclone.conf

COPY common.sh /usr/local/lib/revsign/common.sh
COPY entrypoint.sh backup.sh prune.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/backup.sh /usr/local/bin/prune.sh

ENV TZ=America/Bahia
USER 1001
VOLUME /backups
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

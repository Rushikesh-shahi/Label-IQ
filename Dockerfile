# Label IQ dashboard proxy (see README.md). Built on the server with podman:
#   cd projects/labeliq-dashboard && podman build -t localhost/labeliq-dashboard:latest .
FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app
WORKDIR /srv
COPY proxy.py ./
COPY static ./static
COPY certs ./certs
USER 10001
EXPOSE 8000
CMD ["python", "proxy.py"]

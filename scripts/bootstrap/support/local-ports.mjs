const parsePort = (value, fallback) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fallback;
  }

  return port;
};

export const resolveLocalPorts = (env = process.env) => {
  const requestedConductorBasePort = parsePort(env.CONDUCTOR_PORT, null);
  const conductorBasePort =
    requestedConductorBasePort && requestedConductorBasePort <= 65533
      ? requestedConductorBasePort
      : null;
  const defaultFrontendPort = conductorBasePort ?? 3000;
  const defaultBackendPort = conductorBasePort ? conductorBasePort + 1 : 8080;
  const defaultPostgresPort = conductorBasePort ? conductorBasePort + 2 : 5432;

  return {
    frontend: parsePort(env.RADIOSO_FRONTEND_PORT, defaultFrontendPort),
    backend: parsePort(env.RADIOSO_BACKEND_PORT, defaultBackendPort),
    postgres: parsePort(env.RADIOSO_POSTGRES_PORT, defaultPostgresPort),
  };
};

export const localHttpUrl = (port, path = "") => `http://127.0.0.1:${port}${path}`;

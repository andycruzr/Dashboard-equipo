# Slate — Tráfico Comms
FROM node:20-alpine

WORKDIR /app

# Primero las dependencias: así Docker reutiliza la capa
# mientras no cambie package.json.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# El servidor crea sus tablas al arrancar, no hace falta
# un paso de migración aparte.
CMD ["node", "server.js"]

FROM node:20-alpine

# Los motores de Prisma necesitan OpenSSL; Alpine no lo trae por defecto y
# sin esto falla con "Could not parse schema engine response" al arrancar.
RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npx prisma generate

EXPOSE 3000

# Aplica migraciones pendientes en cada arranque (idempotente: 'migrate deploy'
# solo corre las que faltan) y despues levanta el servidor.
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]

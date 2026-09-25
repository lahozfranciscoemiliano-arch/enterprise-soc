FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Las variables NEXT_PUBLIC_* se incrustan en el bundle del cliente durante
# el build, no se pueden cambiar despues en runtime — por eso son build ARGs.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL

RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# output: 'standalone' en next.config.js genera un server.js autonomo sin
# necesitar node_modules completo en la imagen final -- pero a diferencia de
# .next/static, Next.js NO copia "public/" (imagenes, favicon, etc.) dentro
# del standalone solo: hay que copiarlo a mano o esos assets quedan 404 en
# el contenedor aunque existan en el repo.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3001
CMD ["node", "server.js"]

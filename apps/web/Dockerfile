FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN rm -rf .next && npm run build
EXPOSE 3100
CMD ["npm", "run", "start"]

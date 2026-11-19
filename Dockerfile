FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Hugging Face Spaces uses port 7860 by default; Render injects PORT
ENV PORT=7860
EXPOSE 7860

CMD ["npm", "start"]


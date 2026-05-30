FROM node:25.9.0

RUN mkdir /XChainDecoder/
COPY ./package.json /XChainDecoder/package.json
COPY ./package-lock.json /XChainDecoder/package-lock.json
WORKDIR /XChainDecoder
RUN npm ci --omit=dev

COPY ./src /XChainDecoder/src
COPY ./.en[v] /XChainDecoder/.env

CMD ["npm", "run", "api"]
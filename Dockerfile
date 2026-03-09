FROM node:latest

RUN mkdir /XChainDecoder/
COPY ./package.json /XChainDecoder/package.json
WORKDIR /XChainDecoder
RUN npm install

COPY ./bufferutils.js /XChainDecoder/node_modules/bitcoinjs-lib/src/bufferutils.js
COPY ./src /XChainDecoder/src
COPY ./.en[v] /XChainDecoder/.env

CMD ["npm", "run", "api"]
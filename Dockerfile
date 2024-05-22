FROM node:latest

RUN mkdir /XChainDecoder/
COPY ./package.json /XChainDecoder/package.json
WORKDIR /XChainDecoder
RUN npm install

COPY ./src /XChainDecoder/src
COPY ./.env /XChainDecoder/.env

CMD ["npm", "run", "api"]
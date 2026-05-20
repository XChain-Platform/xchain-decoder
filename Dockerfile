FROM node:25.9.0

RUN mkdir /XChainDecoder/
COPY ./package.json /XChainDecoder/package.json
WORKDIR /XChainDecoder
RUN npm install

COPY ./src /XChainDecoder/src
COPY ./.en[v] /XChainDecoder/.env

CMD ["npm", "run", "api"]
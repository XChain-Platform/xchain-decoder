FROM node:25.9.0

RUN mkdir /XChainDecoder/
COPY ./package.json /XChainDecoder/package.json
COPY ./package-lock.json /XChainDecoder/package-lock.json
WORKDIR /XChainDecoder
RUN npm ci --omit=dev

COPY ./src /XChainDecoder/src
# Patch bitcoinjs-lib's bufferutils with a BigInt-aware 64-bit reader. The stock
# readUInt64 throws "RangeError: value out of range" for output values above
# ~9.007e15 (2^53), which Dogecoin mainnet exceeds (>~90.07M DOGE in one output).
# Mirrors xchain-utxo-tracker's identical patch.
COPY ./src/bufferutils.js /XChainDecoder/node_modules/bitcoinjs-lib/src/bufferutils.js
COPY ./.en[v] /XChainDecoder/.env

CMD ["npm", "run", "api"]
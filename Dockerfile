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
# Mirrors xchain-utxo-tracker's identical patch. Belt-and-braces: the same patch
# is also applied in-process at require time (src/applyBufferutilsPatch.js), so
# non-Docker runs and node_modules refreshes are covered even without this COPY.
COPY ./src/bufferutils.js /XChainDecoder/node_modules/bitcoinjs-lib/src/bufferutils.js
COPY ./.en[v] /XChainDecoder/.env

# Exec-form node, not `npm run api` (which is this exact command). npm builds an
# npm -> sh -c -> node tree and no wrapper forwards signals, so `docker stop`
# kills npm while node is never told anything (measured on the regtest encoder,
# xchain-encoder/Dockerfile). This image registers real drain work on SIGTERM
# (src/api.js: flip decoderRunning, then decoder.stop()), which only runs when
# node is PID 1 and receives the signal itself.
CMD ["node", "./src/api.js"]
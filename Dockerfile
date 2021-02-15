FROM mhart/alpine-node:11.10.0
WORKDIR /app
ADD ./bin/plasma-chain.js /bin/plasma-chain.js
COPY package.json ./

RUN apk update && apk upgrade && \
    apk add --no-cache bash git openssh

RUN apk --no-cache add --virtual native-deps \
  g++ gcc libgcc libstdc++ linux-headers make python && \
  npm install --quiet node-gyp -g &&\
  npm install --quiet && \
  apk del native-deps

RUN npm install

COPY . .

EXPOSE 3000
COPY ./docker-entrypoint.sh /
COPY ./operator-db /
COPY ./operator-keystore /
ENV password=$PLASMA_PASSWORD

ENTRYPOINT ["sh", "/docker-entrypoint.sh"]
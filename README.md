# relay-transport-ws

This is a fork of [subscriptions-transport-ws](https://github.com/apollographql/subscriptions-transport-ws) with support of [persisted queries](https://relay.dev/docs/en/persisted-queries).

# Getting Started

Start by installing the package, using Yarn or NPM.

    Using Yarn:
    $ yarn add relay-transport-ws

    Or, using NPM:
    $ npm install --save relay-transport-ws

> Note that you need to use this package on both GraphQL client and server.

> This command also installs this package's dependencies, including `graphql-subscriptions`.

## Server

Run relay compiler using the --persist-output flag

```bash
relay-compiler --src ./src --schema ./schema.graphql --persist-output ./path/to/persisted-queries.json
```

Now, create `SubscriptionServer` instance, with your GraphQL `schema`, `execute`, `subscribe` and `queryMap`:

```js
import { createServer } from 'http';
import { SubscriptionServer } from 'relay-transport-ws';
import { execute, subscribe } from 'graphql';
import { schema } from './my-schema';

// persisted queries
import queryMap from './path/to/persisted-queries.json'

const WS_PORT = 5000;

// Create WebSocket listener server
const websocketServer = createServer((request, response) => {
  response.writeHead(404);
  response.end();
});

// Bind it to port and start listening
websocketServer.listen(WS_PORT, () => console.log(
  `Websocket Server is now running on http://localhost:${WS_PORT}`
));

const subscriptionServer = SubscriptionServer.create(
  {
    schema,
    execute,
    subscribe,
    queryMap,
  },
  {
    server: websocketServer,
    path: '/graphql',
  },
);
```

### Creating Your Subscriptions

Please refer to [`graphql-subscriptions`](https://github.com/apollographql/graphql-subscriptions) documentation for how to create your GraphQL subscriptions, and how to publish data.


# API Docs

## SubscriptionClient
### `Constructor(url, options, webSocketImpl)`
- `url: string` : url that the client will connect to, starts with `ws://` or `wss://`
- `options?: Object` : optional, object to modify default client behavior
  * `timeout?: number` : how long the client should wait in ms for a keep-alive message from the server (default 30000 ms), this parameter is ignored if the server does not send keep-alive messages. This will also be used to calculate the max connection time per connect/reconnect
  * `lazy?: boolean` : use to set lazy mode - connects only when first subscription created, and delay the socket initialization
  * `connectionParams?: Object | Function | Promise<Object>` : object that will be available as first argument of `onConnect` (in server side), if passed a function - it will call it and send the return value, if function returns as promise - it will wait until it resolves and send the resolved value.
  * `reconnect?: boolean` : automatic reconnect in case of connection error
  * `reconnectionAttempts?: number` : how much reconnect attempts
  * `connectionCallback?: (error) => {}` : optional, callback that called after the first init message, with the error (if there is one)
  * `inactivityTimeout?: number` : how long the client should wait in ms, when there are no active subscriptions, before disconnecting from the server. Set to 0 to disable this behavior. (default 0)
- `webSocketImpl?: Object` - optional, constructor for W3C compliant WebSocket implementation. Use this when your environment does not have a built-in native WebSocket (for example, with NodeJS client)

### Methods
#### `request(options) => Observable<ExecutionResult>`: returns observable to execute the operation.
- `options: {OperationOptions}`
  * `query: string` : GraphQL subscription
  * `variables: Object` : GraphQL subscription variables
  * `operationName: string` : operation name of the subscription
  * `context: Object` : use to override context for a specific call

#### `unsubscribeAll() => void` - unsubscribes from all active subscriptions.

#### `on(eventName, callback, thisContext) => Function`
- `eventName: string`: the name of the event, available events are: `connecting`, `connected`, `reconnecting`, `reconnected`, `disconnected` and `error`
- `callback: Function`: function to be called when websocket connects and initialized.
- `thisContext: any`: `this` context to use when calling the callback function.
- => Returns an `off` method to cancel the event subscription.

#### `onConnected(callback, thisContext) => Function` - shorthand for `.on('connected', ...)`
- `callback: Function`: function to be called when websocket connects and initialized, after ACK message returned from the server
- `thisContext: any`: `this` context to use when calling the callback function.
- => Returns an `off` method to cancel the event subscription.

#### `onReconnected(callback, thisContext) => Function` - shorthand for `.on('reconnected', ...)`
- `callback: Function`: function to be called when websocket reconnects and initialized, after ACK message returned from the server
- `thisContext: any`: `this` context to use when calling the callback function.
- => Returns an `off` method to cancel the event subscription.

#### `onConnecting(callback, thisContext) => Function` - shorthand for `.on('connecting', ...)`
- `callback: Function`: function to be called when websocket starts it's connection
- `thisContext: any`: `this` context to use when calling the callback function.
- => Returns an `off` method to cancel the event subscription.

#### `onReconnecting(callback, thisContext) => Function` - shorthand for `.on('reconnecting', ...)`
- `callback: Function`: function to be called when websocket starts it's reconnection 
- `thisContext: any`: `this` context to use when calling the callback function.
- => Returns an `off` method to cancel the event subscription.

#### `onDisconnected(callback, thisContext) => Function` - shorthand for `.on('disconnected', ...)`
- `callback: Function`: function to be called when websocket disconnected.
- `thisContext: any`: `this` context to use when calling the callback function.
- => Returns an `off` method to cancel the event subscription.

#### `onError(callback, thisContext) => Function` - shorthand for `.on('error', ...)`
- `callback: Function`: function to be called when an error occurs.
- `thisContext: any`: `this` context to use when calling the callback function.
- => Returns an `off` method to cancel the event subscription.

### `close() => void` - closes the WebSocket connection manually, and ignores `reconnect` logic if it was set to `true`.

### `use(middlewares: MiddlewareInterface[]) => SubscriptionClient` - adds middleware to modify `OperationOptions` per each request
- `middlewares: MiddlewareInterface[]` - Array contains list of middlewares (implemented `applyMiddleware` method) implementation, the `SubscriptionClient` will use the middlewares to modify `OperationOptions` for every operation

### `status: number` : returns the current socket's `readyState`


## SubscriptionServer
### `Constructor(options, socketOptions | socketServer)`
- `options: {ServerOptions}`
  * `rootValue?: any` : Root value to use when executing GraphQL root operations
  * `schema?: GraphQLSchema` : GraphQL schema object. If not provided, you have to return the schema as a property on the object returned from `onOperation`.
  * `execute?: (schema, document, rootValue, contextValue, variableValues, operationName) => Promise<ExecutionResult> | AsyncIterator<ExecutionResult>` : GraphQL `execute` function, provide the default one from `graphql` package. Return value of `AsyncItrator` is also valid since this package also support reactive `execute` methods.
  * `subscribe?: (schema, document, rootValue, contextValue, variableValues, operationName) => Promise<ExecutionResult | AsyncIterator<ExecutionResult>>` : GraphQL `subscribe` function, provide the default one from `graphql` package.
  * `onOperation?: (message: SubscribeMessage, params: SubscriptionOptions, webSocket: WebSocket)` : optional method to create custom params that will be used when resolving this operation. It can also be used to dynamically resolve the schema that will be used for the particular operation.
  * `onOperationComplete?: (webSocket: WebSocket, opId: string)` : optional method that called when a GraphQL operation is done (for query and mutation it's immediately, and for subscriptions when unsubscribing)
  * `onConnect?: (connectionParams: Object, webSocket: WebSocket, context: ConnectionContext)` : optional method that called when a client connects to the socket, called with the `connectionParams` from the client, if the return value is an object, its elements will be added to the context. return `false` or throw an exception to reject the connection. May return a Promise.
  * `onDisconnect?: (webSocket: WebSocket, context: ConnectionContext)` : optional method that called when a client disconnects
  * `keepAlive?: number` : optional interval in ms to send `KEEPALIVE` messages to all clients
  * `queryMap: Record<string, DocumentNode | string>` persisted query map.
- `socketOptions: {WebSocket.IServerOptions}` : options to pass to the WebSocket object (full docs [here](https://github.com/websockets/ws/blob/master/doc/ws.md))
  * `server?: HttpServer` - existing HTTP server to use (use without `host`/`port`)
  * `host?: string` - server host
  * `port?: number` - server port
  * `path?: string` - endpoint path

- `socketServer: {WebSocket.Server}` : a configured server if you need more control. Can be used for integration testing with in-memory WebSocket implementation.

## How it works?

* For GraphQL WebSocket protocol docs, [click here](https://github.com/papahigh/relay-transport-ws/blob/master/PROTOCOL.md)
* This package also uses `AsyncIterator` internally using [iterall](https://github.com/leebyron/iterall), for more information [click here](https://github.com/ReactiveX/IxJS), or [the proposal](https://github.com/tc39/proposal-async-iteration)


import {
  DocumentNode,
  ExecutionResult,
  GraphQLFieldResolver,
  GraphQLSchema,
  parse,
  specifiedRules,
  validate,
  ValidationContext,
} from 'graphql'
import { IncomingMessage } from 'http'
import { createAsyncIterator, forAwaitEach, isAsyncIterable } from 'iterall'
import * as WebSocket from 'ws'
import { MessageTypes } from './message-types'
import { GRAPHQL_WS } from './protocol'
import { createEmptyIterable } from './utils/empty-iterable'
import isObject from './utils/is-object'
import { isASubscriptionOperation } from './utils/is-subscriptions'

export type ExecutionIterator = AsyncIterator<ExecutionResult>

export interface ExecutionParams<TContext = any> {
  query?: string | DocumentNode
  variables?: { [key: string]: any }
  operationName?: string
  operationId?: string
  context: TContext
  formatResponse?: Function
  formatError?: Function
  callback?: Function
  schema?: GraphQLSchema
}

export type ConnectionContext = {
  initPromise?: Promise<any>
  socket: WebSocket
  request: IncomingMessage
  operations: {
    [opId: string]: ExecutionIterator
  }
  [key: string]: any
}

export interface OperationMessagePayload {
  query?: string
  variables?: { [key: string]: any }
  operationName?: string
  operationId?: string

  [key: string]: any // this will support for example any options sent in init like the auth token
}

export interface OperationMessage {
  payload?: OperationMessagePayload
  id?: string
  type: string
}

export type ExecuteFunction = (
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: any,
  contextValue?: any,
  variableValues?: { [key: string]: any },
  operationName?: string,
  fieldResolver?: GraphQLFieldResolver<any, any>,
) => ExecutionResult | Promise<ExecutionResult> | AsyncIterator<ExecutionResult>

export type SubscribeFunction = (
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: any,
  contextValue?: any,
  variableValues?: { [key: string]: any },
  operationName?: string,
  fieldResolver?: GraphQLFieldResolver<any, any>,
  subscribeFieldResolver?: GraphQLFieldResolver<any, any>,
) => AsyncIterator<ExecutionResult> | Promise<AsyncIterator<ExecutionResult> | ExecutionResult>

export interface ServerOptions {
  rootValue?: any
  schema?: GraphQLSchema
  execute?: ExecuteFunction
  subscribe?: SubscribeFunction
  validationRules?: Array<(context: ValidationContext) => any> | ReadonlyArray<any>
  onOperation?: Function
  onOperationComplete?: Function
  onConnect?: Function
  onDisconnect?: Function
  keepAlive?: number
  queryMap?: Record<string, DocumentNode | string>
}

const isWebSocketServer = (socket: any): socket is WebSocket.Server => socket.on

export class SubscriptionServer {
  public static create(options: ServerOptions, socketOptionsOrServer: WebSocket.ServerOptions | WebSocket.Server) {
    return new SubscriptionServer(options, socketOptionsOrServer)
  }

  private static sendKeepAlive(connectionContext: ConnectionContext) {
    SubscriptionServer.sendMessage(connectionContext, undefined, MessageTypes.GQL_CONNECTION_KEEP_ALIVE, undefined)
  }

  private static sendMessage(
    connectionContext: ConnectionContext,
    opId: string | null | undefined,
    type: string,
    payload: any,
  ): void {
    if (connectionContext.socket.readyState === WebSocket.OPEN) {
      const parsedMessage = { id: opId, type, payload }
      connectionContext.socket.send(JSON.stringify(parsedMessage))
    }
  }

  private static sendError(
    connectionContext: ConnectionContext,
    opId: string | null | undefined,
    errorPayload: any,
    overrideDefaultErrorType?: string,
  ): void {
    const sanitizedOverrideDefaultErrorType = overrideDefaultErrorType || MessageTypes.GQL_ERROR
    if (
      [MessageTypes.GQL_CONNECTION_ERROR, MessageTypes.GQL_ERROR].indexOf(
        sanitizedOverrideDefaultErrorType as MessageTypes,
      ) === -1
    ) {
      throw new Error(
        'overrideDefaultErrorType should be one of the allowed error messages GQL_CONNECTION_ERROR or GQL_ERROR',
      )
    }

    SubscriptionServer.sendMessage(connectionContext, opId, sanitizedOverrideDefaultErrorType, errorPayload)
  }

  public get server(): WebSocket.Server {
    return this.wsServer
  }

  constructor(options: ServerOptions, socketOptionsOrServer: WebSocket.ServerOptions | WebSocket.Server) {
    const { onOperation, onOperationComplete, onConnect, onDisconnect, keepAlive, queryMap } = options

    this.specifiedRules = options.validationRules || specifiedRules
    this.loadExecutor(options)

    this.onOperation = onOperation
    this.onOperationComplete = onOperationComplete
    this.onConnect = onConnect
    this.onDisconnect = onDisconnect
    this.keepAlive = keepAlive
    this.queryMap = queryMap

    if (isWebSocketServer(socketOptionsOrServer)) {
      this.wsServer = socketOptionsOrServer
    } else {
      // Init and connect WebSocket server to http
      this.wsServer = new WebSocket.Server(socketOptionsOrServer || {})
    }

    const connectionHandler = (socket: WebSocket, request: IncomingMessage) => {
      // Add `upgradeReq` to the socket object to support old API, without creating a memory leak
      // See: https://github.com/websockets/ws/pull/1099
      // @ts-ignore
      socket.upgradeReq = request
      // NOTE: the old GRAPHQL_SUBSCRIPTIONS protocol support should be removed in the future
      if (socket.protocol === undefined || socket.protocol.indexOf(GRAPHQL_WS) === -1) {
        // Close the connection with an error code, ws v2 ensures that the
        // connection is cleaned up even when the closing handshake fails.
        // 1002: protocol error
        socket.close(1002)
        return
      }

      const connectionContext: ConnectionContext = Object.create(null)
      connectionContext.initPromise = Promise.resolve(true)
      connectionContext.socket = socket
      connectionContext.request = request
      connectionContext.operations = {}

      const connectionClosedHandler = (error: any) => {
        if (error) {
          SubscriptionServer.sendError(
            connectionContext,
            '',
            { message: error.message ? error.message : error },
            MessageTypes.GQL_CONNECTION_ERROR,
          )

          // 1011 is an unexpected condition prevented the request from being fulfilled
          setTimeout(() => connectionContext.socket.close(1011), 10)
        }
        this.onClose(connectionContext)

        if (this.onDisconnect) {
          this.onDisconnect(socket, connectionContext)
        }
      }

      socket.on('error', connectionClosedHandler)
      socket.on('close', connectionClosedHandler)
      socket.on('message', this.onMessage(connectionContext))
    }

    this.wsServer.on('connection', connectionHandler)
    this.closeHandler = () => {
      this.wsServer.removeListener('connection', connectionHandler)
      this.wsServer.close()
    }
  }
  private onOperation?: Function
  private readonly onOperationComplete?: Function
  private readonly onConnect?: Function
  private readonly onDisconnect?: Function
  private readonly wsServer: WebSocket.Server
  private readonly closeHandler: () => void
  private readonly queryMap?: Record<string, DocumentNode | string>

  private execute: ExecuteFunction
  private subscribe?: SubscribeFunction
  private schema?: GraphQLSchema
  private rootValue: any
  private keepAlive?: number
  private specifiedRules: Array<(context: ValidationContext) => any> | ReadonlyArray<any>

  public close(): void {
    this.closeHandler()
  }

  private loadExecutor(options: ServerOptions) {
    const { execute, subscribe, schema, rootValue } = options

    if (!execute) {
      throw new Error('Must provide `execute` for websocket server constructor.')
    }

    this.schema = schema
    this.rootValue = rootValue
    this.execute = execute
    this.subscribe = subscribe
  }

  private unsubscribe(connectionContext: ConnectionContext, opId: string | null | undefined) {
    if (opId && connectionContext.operations && connectionContext.operations[opId]) {
      if (connectionContext.operations[opId].return) {
        connectionContext.operations[opId].return()
      }

      delete connectionContext.operations[opId]

      if (this.onOperationComplete) {
        this.onOperationComplete(connectionContext.socket, opId)
      }
    }
  }

  private onClose(connectionContext: ConnectionContext) {
    Object.keys(connectionContext.operations).forEach(opId => {
      this.unsubscribe(connectionContext, opId)
    })
  }

  private onMessage(connectionContext: ConnectionContext) {
    return (message: any) => {
      let parsedMessage: OperationMessage
      try {
        parsedMessage = JSON.parse(message)
      } catch (e) {
        SubscriptionServer.sendError(connectionContext, null, { message: e.message }, MessageTypes.GQL_CONNECTION_ERROR)
        return
      }

      const opId = parsedMessage.id
      switch (parsedMessage.type) {
        case MessageTypes.GQL_CONNECTION_INIT:
          if (this.onConnect) {
            connectionContext.initPromise = new Promise((resolve, reject) => {
              try {
                // TODO - this should become a function call with just 2 arguments in the future
                // when we release the breaking change api: parsedMessage.payload and connectionContext
                resolve(this.onConnect(parsedMessage.payload, connectionContext.socket, connectionContext))
              } catch (e) {
                reject(e)
              }
            })
          }

          connectionContext.initPromise
            ?.then(result => {
              if (result === false) {
                throw new Error('Prohibited connection!')
              }

              SubscriptionServer.sendMessage(connectionContext, undefined, MessageTypes.GQL_CONNECTION_ACK, undefined)

              if (this.keepAlive) {
                SubscriptionServer.sendKeepAlive(connectionContext)
                // Regular keep alive messages if keepAlive is set
                const keepAliveTimer = setInterval(() => {
                  if (connectionContext.socket.readyState === WebSocket.OPEN) {
                    SubscriptionServer.sendKeepAlive(connectionContext)
                  } else {
                    clearInterval(keepAliveTimer)
                  }
                }, this.keepAlive)
              }
            })
            .catch((error: Error) => {
              SubscriptionServer.sendError(
                connectionContext,
                opId,
                { message: error.message },
                MessageTypes.GQL_CONNECTION_ERROR,
              )

              // Close the connection with an error code, ws v2 ensures that the
              // connection is cleaned up even when the closing handshake fails.
              // 1011: an unexpected condition prevented the operation from being fulfilled
              // We are using setTimeout because we want the message to be flushed before
              // disconnecting the client
              setTimeout(() => connectionContext.socket.close(1011), 10)
            })
          break

        case MessageTypes.GQL_CONNECTION_TERMINATE:
          connectionContext.socket.close()
          break

        case MessageTypes.GQL_START:
          connectionContext.initPromise
            ?.then(initResult => {
              // if we already have a subscription with this id, unsubscribe from it first
              if (opId && connectionContext.operations && connectionContext.operations[opId]) {
                this.unsubscribe(connectionContext, opId)
              }

              const baseParams: ExecutionParams = {
                query: parsedMessage.payload?.query,
                variables: parsedMessage.payload?.variables,
                operationId: parsedMessage.payload?.operationId,
                operationName: parsedMessage.payload?.operationName,
                context: isObject(initResult)
                  ? Object.assign(Object.create(Object.getPrototypeOf(initResult)), initResult)
                  : {},
                formatResponse: undefined,
                formatError: undefined,
                callback: undefined,
                schema: this.schema,
              }
              let promisedParams = Promise.resolve(baseParams)

              // set an initial mock subscription to only registering opId
              if (opId) {
                connectionContext.operations[opId] = createEmptyIterable()
              }

              if (this.onOperation) {
                const messageForCallback: any = parsedMessage
                promisedParams = Promise.resolve(
                  this.onOperation(messageForCallback, baseParams, connectionContext.socket),
                )
              }

              promisedParams
                .then(params => {
                  if (typeof params !== 'object') {
                    const error = `Invalid params returned from onOperation! return values must be an object!`
                    SubscriptionServer.sendError(connectionContext, opId, { message: error })

                    throw new Error(error)
                  }

                  if (!params.schema) {
                    const error =
                      'Missing schema information. The GraphQL schema should be provided either statically in' +
                      ' the `SubscriptionServer` constructor or as a property on the object returned from onOperation!'
                    SubscriptionServer.sendError(connectionContext, opId, { message: error })

                    throw new Error(error)
                  }

                  let document: DocumentNode | undefined
                  let shouldValidate: boolean | undefined
                  if (baseParams.query) {
                    document = typeof baseParams.query !== 'string' ? baseParams.query : parse(baseParams.query)
                    shouldValidate = true
                  } else if (baseParams.operationId && this.queryMap) {
                    const query = this.queryMap[baseParams.operationId]
                    document = typeof query === 'string' ? parse(query) : query
                    shouldValidate = false
                  }

                  if (!document) {
                    const error =
                      'Missing query information. The GraphQL query information should be provided either via query oa as na operationId'
                    SubscriptionServer.sendError(connectionContext, opId, { message: error })
                    throw new Error(error)
                  }

                  let executionPromise: Promise<AsyncIterator<ExecutionResult> | ExecutionResult>

                  const validationErrors =
                    (shouldValidate && validate(params.schema, document, this.specifiedRules)) || []

                  if (validationErrors.length > 0) {
                    executionPromise = Promise.resolve({ errors: validationErrors })
                  } else {
                    let executor: SubscribeFunction | ExecuteFunction = this.execute
                    if (this.subscribe && isASubscriptionOperation(document, params.operationName)) {
                      executor = this.subscribe
                    }
                    executionPromise = Promise.resolve(
                      executor(
                        params.schema,
                        document,
                        this.rootValue,
                        params.context,
                        params.variables,
                        params.operationName,
                      ),
                    )
                  }

                  return executionPromise.then(executionResult => ({
                    executionIterable: isAsyncIterable(executionResult)
                      ? executionResult
                      : createAsyncIterator([executionResult]),
                    params,
                  }))
                })
                .then(({ executionIterable, params }) => {
                  forAwaitEach(executionIterable as any, (value: ExecutionResult) => {
                    let result = value

                    if (params.formatResponse) {
                      try {
                        result = params.formatResponse(value, params)
                      } catch (err) {
                        console.error('Error in formatResponse function:', err)
                      }
                    }

                    SubscriptionServer.sendMessage(connectionContext, opId, MessageTypes.GQL_DATA, result)
                  })
                    .then(() => {
                      SubscriptionServer.sendMessage(connectionContext, opId, MessageTypes.GQL_COMPLETE, null)
                    })
                    .catch((e: Error) => {
                      let error = e

                      if (params.formatError) {
                        try {
                          error = params.formatError(e, params)
                        } catch (err) {
                          console.error('Error in formatError function: ', err)
                        }
                      }

                      // plain Error object cannot be JSON stringified.
                      if (Object.keys(e).length === 0) {
                        error = { name: e.name, message: e.message }
                      }

                      SubscriptionServer.sendError(connectionContext, opId, error)
                    })

                  return executionIterable
                })
                .then(subscription => {
                  // @ts-ignore
                  connectionContext.operations[opId] = subscription
                })
                .catch((e: any) => {
                  if (e.errors) {
                    SubscriptionServer.sendMessage(connectionContext, opId, MessageTypes.GQL_DATA, { errors: e.errors })
                  } else {
                    SubscriptionServer.sendError(connectionContext, opId, { message: e.message })
                  }

                  // Remove the operation on the server side as it will be removed also in the client
                  this.unsubscribe(connectionContext, opId)
                  return
                })
              return promisedParams
            })
            .catch(error => {
              // Handle initPromise rejected
              SubscriptionServer.sendError(connectionContext, opId, { message: error.message })
              this.unsubscribe(connectionContext, opId)
            })
          break

        case MessageTypes.GQL_STOP:
          // Find subscription id. Call unsubscribe.
          this.unsubscribe(connectionContext, opId)
          break

        default:
          SubscriptionServer.sendError(connectionContext, opId, { message: 'Invalid message type!' })
      }
    }
  }
}

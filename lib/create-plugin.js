/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const ErrorHelper = require('./error-helper.js')
const errorHelper = new ErrorHelper()
const cleanQuery = require('./query-utils')

const NOTICED_ERRORS = ErrorHelper.NOTICED_ERRORS

const ANON_PLACEHOLDER = '<anonymous>'

const CATEGORY = 'GraphQL'
const FRAMEWORK = 'ApolloServer'
const OPERATION_PREFIX = CATEGORY + '/operation/' + FRAMEWORK
const RESOLVE_PREFIX = CATEGORY + '/resolve/' + FRAMEWORK
const ARG_PREFIX = `${CATEGORY}/arg/${FRAMEWORK}`
const FIELD_PREFIX = `${CATEGORY}/field/${FRAMEWORK}`
const BATCH_PREFIX = 'batch'

const DEFAULT_OPERATION_NAME = `${OPERATION_PREFIX}/<unknown>`

const FIELD_NAME_ATTR = 'graphql.field.name'
const RETURN_TYPE_ATTR = 'graphql.field.returnType'
const PARENT_TYPE_ATTR = 'graphql.field.parentType'
const FIELD_PATH_ATTR = 'graphql.field.path'
const FIELD_ARGS_ATTR = 'graphql.field.args'
const OPERATION_TYPE_ATTR = 'graphql.operation.type'
const OPERATION_NAME_ATTR = 'graphql.operation.name'
const OPERATION_QUERY_ATTR = 'graphql.operation.query'

const INTROSPECTION_TYPES = ['__schema', '__type']
const IGNORED_PATH_FIELDS = ['id', '__typename']
const SERVICE_DEFINITION_QUERY_NAME = '__ApolloGetServiceDefinition__'
const HEALTH_CHECK_QUERY_NAME = '__ApolloServiceHealthCheck__'

const DESTINATIONS = {
  NONE: 0x00
}

/* eslint sonarjs/cognitive-complexity: ["error", 57] -- TODO: https://issues.newrelic.com/browse/NEWRELIC-8797 */
/**
 * Creates an Apollo Server plugin for capturing timing data
 * via the New Relic Node.js agent.
 * @param {*} instrumentationApi New Relic instrumentation API
 * @param {PluginConfig} [config]
 */
function createPlugin(api, config = {}) {
  if (!api?.shim) {
    return {}
  }
  const instrumentationApi = api.shim

  const logger = instrumentationApi.logger.child({ component: 'ApolloServerPlugin' })

  logger.info('Apollo Server plugin created.')

  config.captureScalars = config.captureScalars || false
  config.captureIntrospectionQueries = config.captureIntrospectionQueries || false
  config.captureServiceDefinitionQueries = config.captureServiceDefinitionQueries || false
  config.captureHealthCheckQueries = config.captureHealthCheckQueries || false
  config.customResolverAttributes = config.customResolverAttributes || null
  config.customOperationAttributes = config.customOperationAttributes || null
  config.captureFieldMetrics = config.captureFieldMetrics || false
  logger.debug('Plugin configuration: ', config)

  createModuleUsageMetric(instrumentationApi.agent)

  return {
    requestDidStart(requestContext) {
      logger.trace('Begin requestDidStart')

      const requestParent = instrumentationApi.getActiveSegment()

      if (!requestParent) {
        logger.trace('No active segment found at query start. Not recording.')
        return null
      }

      // We do not set to active here as batched queries will hit this
      // back to back and we'd prefer those not nest with each-other.
      const operationSegment = instrumentationApi.createSegment(
        DEFAULT_OPERATION_NAME,
        recordOperationSegment,
        requestParent
      )

      if (!operationSegment) {
        logger.trace('Operation segment was not created. Not recording.')
        return null
      }

      operationSegment.start()

      return {
        didResolveOperation(resolveContext) {
          updateOperationSegmentName(resolveContext, operationSegment)
          if (shouldIgnoreTransaction(resolveContext.operation, config, logger)) {
            const activeSegment = instrumentationApi.getActiveSegment()
            if (activeSegment) {
              const transaction = activeSegment.transaction
              transaction.setForceIgnore(true)
            }
          }
        },
        didEncounterErrors(errorsRequestContext) {
          // Since we don't set the operation segment as active, we want to apply the
          // operation segment as active while setting the error to appropriately assign
          // error attributes for any errors we've not noticed on field resolve.
          instrumentationApi.applySegment(function addErrors() {
            errorHelper.addErrorsFromApolloRequestContext(instrumentationApi, errorsRequestContext)
          }, operationSegment)
        },
        executionDidStart() {
          // Needed for proper sub-graph external call nesting with federation gateway.
          // We do this here to avoid mis-nesting batch operation calls which
          // hit didResolveOperation back to back.
          instrumentationApi.setActiveSegment(operationSegment)

          return {
            willResolveField(resolverContext) {
              const { info, args } = resolverContext
              const pathArray = flattenToArray(info.path)
              const formattedPath = pathArray.reverse().join('.')
              const flattenedArgs = flattenArgs({ obj: args })

              maybeCaptureFieldMetrics({ operationSegment, info, args: flattenedArgs, config })

              if (!config.captureScalars && !isTopLevelField(info) && isScalar(info)) {
                return null
              }

              const currentSeg = instrumentationApi.getActiveSegment()

              // Nest everything under operation as resolvers start/finish
              // in order but instrumentation such as promise tracking might
              // try to treat as nested.
              const resolverSegment = instrumentationApi.createSegment(
                `${RESOLVE_PREFIX}/${info.fieldName}`,
                recordResolveSegment,
                operationSegment
              )

              if (!resolverSegment) {
                logger.trace('Resolver segment was not created (%s).', formattedPath)

                return null
              }

              resolverSegment.start()
              instrumentationApi.setActiveSegment(resolverSegment)

              resolverSegment.name = `${RESOLVE_PREFIX}/${formattedPath}`
              resolverSegment.addAttribute(FIELD_PATH_ATTR, formattedPath)
              resolverSegment.addAttribute(FIELD_NAME_ATTR, info.fieldName)
              resolverSegment.addAttribute(RETURN_TYPE_ATTR, info.returnType.toString())
              resolverSegment.addAttribute(PARENT_TYPE_ATTR, info.parentType.toString())

              if (instrumentationApi.isFunction(config.customResolverAttributes)) {
                const customAttributes = config.customResolverAttributes(resolverContext)
                api.addCustomAttributes(customAttributes)
              }

              // Like our http and framework instrumentation, we add
              // the attributes on the operation segment. We also add
              // the attributes to resolver segments as they help
              // inform performance impacts.
              for (const segment of [operationSegment, resolverSegment]) {
                for (const [key, value] of Object.entries(flattenedArgs)) {
                  // Require adding to attribute 'include' configuration
                  // so as not to accidentally send sensitive info to New Relic.
                  segment.attributes.addAttribute(
                    DESTINATIONS.NONE,
                    `${FIELD_ARGS_ATTR}.${key}`,
                    value
                  )
                }
              }

              return (error) => {
                if (error) {
                  // This handler is invoked prior to didEncounterErrors
                  // which means we need to handle the error now to capture
                  // in context of the appropriate span.
                  errorHelper.noticeError(instrumentationApi, error)
                  requestContext[NOTICED_ERRORS] = requestContext[NOTICED_ERRORS] || []
                  requestContext[NOTICED_ERRORS].push(error)
                }

                resolverSegment.end()
                instrumentationApi.setActiveSegment(currentSeg)
              }
            }
          }
        },
        willSendResponse(responseContext) {
          // check if operation segment was never updated from default name
          // If so, try to rename before setting the transaction name to `*`
          if (operationSegment.name === DEFAULT_OPERATION_NAME) {
            const updated = updateOperationSegmentName(responseContext, operationSegment)
            if (!updated) {
              setTransactionName(operationSegment.transaction, '*')
            }
          }

          if (instrumentationApi.isFunction(config.customOperationAttributes)) {
            const customAttributes = config.customOperationAttributes(responseContext)
            api.addCustomAttributes(customAttributes)
          }

          operationSegment.end()

          logger.trace('End willSendResponse')
        }
      }
    }
  }
}

function getOperationDetails(responseContext) {
  if (!responseContext.document) {
    return null
  }

  return getDetailsFromDocument(responseContext)
}

function isScalar(fieldInfo) {
  return isScalarType(fieldInfo.returnType) || isNonNullScalarType(fieldInfo.returnType)
}

function isScalarType(typeInstance) {
  const typeName = typeInstance.constructor.name
  return typeName === 'GraphQLScalarType'
}

function isNonNullScalarType(returnType) {
  const returnTypeName = returnType.constructor.name
  if (returnTypeName !== 'GraphQLNonNull' || !returnType.ofType) {
    return false
  }

  const nestedType = returnType.ofType
  return isScalarType(nestedType)
}

function isTopLevelField(fieldInfo) {
  const parentName = fieldInfo.parentType.name
  return parentName === 'Query' || parentName === 'Mutation'
}

/**
 * fragments could be defined for a given operation.  This iterates over the definitions
 * to find the operation definition to avoid issues with naming
 * see: https://github.com/newrelic/newrelic-node-apollo-server-plugin/issues/175
 *
 * @param {Array} definitions
 */
function findOperationDefinition(definitions) {
  return definitions.find((definition) => definition.kind === 'OperationDefinition')
}

function getDetailsFromDocument(responseContext) {
  const definition = findOperationDefinition(responseContext.document.definitions)

  const pathAndArgs = getDeepestPathAndQueryArguments(definition)

  // always use context.source so we can get both queries and persisted queries
  // see: https://github.com/apollographql/apollo-server/blob/2bccec2c5f5adaaf785f13ab98b6e52e22d5b22e/packages/apollo-server-core/src/requestPipeline.ts#L232
  const query = cleanQuery(responseContext.source, pathAndArgs.argLocations)

  const deepestUniquePath = pathAndArgs.deepestPath

  const definitionName = definition.name && definition.name.value

  return {
    operationType: definition.operation,
    operationName: definitionName,
    deepestUniquePath: deepestUniquePath.join('.'),
    cleanedQuery: query
  }
}

function flattenToArray(fieldPath) {
  const pathArray = []

  let thisPath = fieldPath
  while (thisPath) {
    if (typeof thisPath.key !== 'number') {
      pathArray.push(thisPath.key)
    }
    thisPath = thisPath.prev
  }

  return pathArray
}

/**
 * Takes a nested object and flattens the key/values
 * { book: { author: { name: 'George Orwell' }, title: '1984' }}
 * would flatten to { book.author.name: 'George Orwell', book.title: '1984' }
 *
 * @param {object} args
 * @param {object} result resulting object
 * @param {string} [prefix=''] prefix of key
 * @param {object} obj object to flatten
 */
function flattenArgs({ result = {}, prefix = '', obj }) {
  for (const key in obj) {
    if (typeof obj[key] === 'object') {
      flattenArgs({ result, prefix: prefix + key + '.', obj: obj[key] })
    } else {
      result[prefix + key] = obj[key]
    }
  }

  return result
}

function setTransactionName(transaction, transactionName) {
  const nameState = transaction.nameState
  if (!nameState.graphql) {
    // Override previously set path stack set thus far by web framework.
    nameState.setName(nameState.prefix, nameState.verb, nameState.delimiter, transactionName)

    // Indicate we've set a name via graphql and future attempts to name
    // are a part of a batch query request to apollo.
    nameState.graphql = true
  } else {
    // If this is a batch query, add 'batch' indicator to the first part of the
    // name unless we've already done so processing a prior query in the batch.
    const firstPart = nameState.pathStack[0]
    if (firstPart.path !== BATCH_PREFIX) {
      nameState.pathStack.unshift({ path: BATCH_PREFIX, params: null })
    }

    nameState.appendPath(transactionName)
  }
}

/**
 * Checks if selection is an InlineFragment that is a
 * NamedType
 * see: https://graphql.org/learn/queries/#inline-fragments
 *
 * @param {Object} selection node in grapql document AST
 */
function isNamedType(selection) {
  return (
    selection.kind === 'InlineFragment' &&
    selection.typeCondition &&
    selection.typeCondition.kind === 'NamedType' &&
    selection.typeCondition.name
  )
}

/**
 * Returns an object with the deepest path in the document definition selectionSet
 * along with query argument locations in raw query string.
 * Deepest path is built from field names where only one field is in selectionSet.
 *
 * 'id' and '__typename' fields are filtered out of consideration to improve
 * naming in sub graph scenarios.
 */
function getDeepestPathAndQueryArguments(definition) {
  let deepestPath = []
  let foundDeepestPath = false
  const argLocations = []

  definition.selectionSet.selections.forEach((selection) => {
    searchSelection(selection)
  })

  return {
    deepestPath,
    argLocations
  }

  /**
   * Search each selection path until no-more sub-selections
   * exist. If the current path is deeper than deepestPath,
   * deepestPath is replaced.
   */
  function searchSelection(selection, currentParts) {
    const parts = currentParts ? [...currentParts] : []

    // capture the arguments for a selection
    if (selection.arguments && selection.arguments.length > 0) {
      selection.arguments.forEach((arg) => {
        argLocations.push(arg.loc)
      })
    }

    if (!foundDeepestPath) {
      // Build up deepest path
      if (isNamedType(selection)) {
        const lastItemIdx = parts.length - 1
        // add type to the last item in parts array
        // (i.e - `_entities<Human>`)
        parts[lastItemIdx] = `${parts[lastItemIdx]}<${selection.typeCondition.name.value}>`
      } else {
        // Add selection name to deepest path
        selection.name &&
          IGNORED_PATH_FIELDS.indexOf(selection.name.value) < 0 &&
          parts.push(selection.name.value)
      }
    }

    // end if no more selections
    if (selection.selectionSet) {
      // Filter selections used for naming
      const filtered = filterSelectionsForDeepestPath(selection.selectionSet.selections)

      // When no selections returned from filtering, deepest path is found
      if (filtered.length === 0 || filtered.length > 1) {
        foundDeepestPath = true
        deepestPath = parts
      }

      // Recurse through inner selections
      filtered.forEach((innerSelection) => {
        searchSelection(innerSelection, parts)
      })
    } else if (!deepestPath.length || parts.length > deepestPath.length) {
      // Add selection parts to deepest path if we're not done
      deepestPath = parts
    }
  }
}

/**
 * Creates metrics for resolver fields when transaction is ended.
 * This will record how long specific resolvers took.
 *
 * @param {Object} params.config plugin config
 * @param {Object} segment relevant resolver segment
 * @param {string} scope name of transaction
 */
function recordResolveSegment(segment, scope) {
  const duration = segment.getDurationInMillis()
  const exclusive = segment.getExclusiveDurationInMillis()

  const transaction = segment.transaction

  const attributes = segment.getAttributes()
  const fieldName = attributes[FIELD_NAME_ATTR]
  const fieldType = attributes[PARENT_TYPE_ATTR]

  // The segment name uses the path to differentiate between duplicate
  // names resolving across different types. Here we use the field name
  // with parent type to compare resolver across usage and transactions.
  if (fieldName && fieldType) {
    const typedFieldMetric = `${RESOLVE_PREFIX}/${fieldType}.${fieldName}`
    createMetricPairs(transaction, typedFieldMetric, scope, duration, exclusive)
  }
}

function filterSelectionsForDeepestPath(selections) {
  return selections.filter((currentSelection) => {
    // Inline fragments describe the prior element (_entities or unions) but contain
    // selections for further naming.
    if (currentSelection.kind === 'InlineFragment') {
      return true
    }

    return IGNORED_PATH_FIELDS.indexOf(currentSelection.name.value) < 0
  })
}

function recordOperationSegment(segment, scope) {
  const duration = segment.getDurationInMillis()
  const exclusive = segment.getExclusiveDurationInMillis()

  const transaction = segment.transaction

  createMetricPairs(transaction, segment.name, scope, duration, exclusive)
}

function createMetricPairs(transaction, name, scope, duration, exclusive) {
  if (scope) {
    transaction.measure(name, scope, duration, exclusive)
  }

  transaction.measure(name, null, duration, exclusive)
}

function createModuleUsageMetric(agent) {
  agent.metrics
    .getOrCreateMetric('Supportability/ExternalModules/ApolloServerPlugin')
    .incrementCallCount()
}

function isIntrospectionQuery(operation) {
  return operation.selectionSet.selections.every((selection) => {
    const fieldName = selection.name.value
    return INTROSPECTION_TYPES.includes(fieldName)
  })
}

function isServiceDefinitionQuery(operation) {
  return operation.name && operation.name.value === SERVICE_DEFINITION_QUERY_NAME
}

function isHealthCheckQuery(operation) {
  return operation.name && operation.name.value === HEALTH_CHECK_QUERY_NAME
}

function shouldIgnoreTransaction(operation, config, logger) {
  if (!operation) {
    logger.trace('`operation` is undefined. Skipping query type check.')
    return false
  }

  if (!config.captureIntrospectionQueries && isIntrospectionQuery(operation)) {
    logger.trace(
      'Request is an introspection query and ' +
        '`config.captureIntrospectionQueries` is set to `false`. Force ignoring the transaction.'
    )

    return true
  }

  if (!config.captureServiceDefinitionQueries && isServiceDefinitionQuery(operation)) {
    logger.trace(
      'Request is an Apollo Federated Gateway service definition query and ' +
        '`config.captureServiceDefinitionQueries` is set to `false`. Force ignoring the transaction.'
    )

    return true
  }

  if (!config.captureHealthCheckQueries && isHealthCheckQuery(operation)) {
    logger.trace(
      'Request is an Apollo Federated Gateway health check query and ' +
        '`config.captureHealthCheckQueries` is set to `false`. ' +
        'Force ignoring the transaction.'
    )

    return true
  }

  return false
}

/**
 * Attempts to extract the document from the request context and
 * add attributes for the query, operation type, operation name and
 * update the transaction name based on operation name as well
 *
 * @param {Object} context apollo request context
 * @param {Segment} operationSegment default segment created in request start
 * @return {Boolean} true if document could be parsed from context
 */
function updateOperationSegmentName(context, operationSegment) {
  const operationDetails = getOperationDetails(context)
  if (operationDetails) {
    const { operationName, operationType, deepestUniquePath, cleanedQuery } = operationDetails

    operationSegment.addAttribute(OPERATION_QUERY_ATTR, cleanedQuery)

    operationSegment.addAttribute(OPERATION_TYPE_ATTR, operationType)

    if (operationName) {
      operationSegment.addAttribute(OPERATION_NAME_ATTR, operationName)
    }

    const formattedName = operationName || ANON_PLACEHOLDER
    let formattedOperation = `${operationType}/${formattedName}`

    // Certain requests, such as introspection, won't hit any resolvers
    if (deepestUniquePath) {
      formattedOperation += `/${deepestUniquePath}`
    }

    const segmentName = formattedOperation
    const transactionName = formattedOperation
    setTransactionName(operationSegment.transaction, transactionName)
    operationSegment.name = `${OPERATION_PREFIX}/${segmentName}`
    return true
  }

  return false
}

/**
 * Captures both field and args of resolvers as metrics.
 *
 * This is intended to be used to determine if a field within a graphql schema is still being requested.
 *
 * @param {Object} params
 * @param {Object} params.config plugin config
 * @param {Object} params.info info key from resolver context
 * @param {Object} params.operationSegment operation segment
 * @param {Object} params.args args key from resolver context
 *
 */
function maybeCaptureFieldMetrics({ config, info, operationSegment, args }) {
  if (config.captureFieldMetrics) {
    const transaction = operationSegment.transaction
    const fieldName = info.fieldName
    const fieldType = info.parentType.toString()
    captureFieldMetrics({ transaction, args, fieldName, fieldType })
  }
}

/**
 * Used to create metrics that just increment call count.  Intended to be
 * used to report on when we see args in a resolver
 *
 * @param {Object} agent active agent instance
 * @param {String} name metric name
 */
function createCallCountMetric(transaction, name) {
  const metric = transaction.metrics.getOrCreateMetric(name)
  metric.incrementCallCount()
}

/**
 * Captures both field and args of resolvers as metrics.
 *
 * This is intended to be used to determine if a field within a graphql schema is still being requested.
 *
 * @param {Object} params
 * @param {Object} params.transaction active transaction
 * @param {Object} params.args args key from resolver context
 * @param {Object} params.fieldType parent type of field
 * @param {Object} params.fieldName name of field
 *
 */
function captureFieldMetrics({ transaction, args, fieldType, fieldName }) {
  const fieldMetric = `${FIELD_PREFIX}/${fieldType}.${fieldName}`
  createCallCountMetric(transaction, fieldMetric)
  Object.entries(args).forEach(([key]) => {
    const name = `${ARG_PREFIX}/${fieldType}.${fieldName}/${key}`
    createCallCountMetric(transaction, name)
  })
}

module.exports = createPlugin

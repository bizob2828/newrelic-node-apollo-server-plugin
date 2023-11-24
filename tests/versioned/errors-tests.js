/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const { executeQuery, makeRequest } = require('../test-client')
const agentTesting = require('../agent-testing')

const ANON_PLACEHOLDER = '<anonymous>'
const UNKNOWN_OPERATION = '<unknown>'

const OPERATION_PREFIX = 'GraphQL/operation/ApolloServer'
const RESOLVE_PREFIX = 'GraphQL/resolve/ApolloServer'

/**
 * Creates a set of standard error capture tests to run against various
 * apollo-server libraries.
 * It is required that t.context.helper and t.context.serverUrl are set.
 * @param {*} t a tap test instance
 */
function createErrorTests(t, _, isApollo4) {
  t.test('parsing error should be noticed and assigned to operation span', (t) => {
    const { helper, serverUrl } = t.context

    const expectedErrorMessage = 'Syntax Error: Expected Name, found <EOF>.'
    const expectedErrorType = 'GraphQLError'

    const invalidQuery = `query {
      libraries {
        books {
          title
          author {
            name
          }
        }
      }
    ` // missing closing }

    helper.agent.once('transactionFinished', (transaction) => {
      const errorTraces = agentTesting.getErrorTraces(helper.agent)
      t.equal(errorTraces.length, 1)

      const errorTrace = errorTraces[0]

      const [, transactionName, errorMessage, errorType, params] = errorTrace
      t.equal(transactionName, transaction.name)
      t.equal(errorMessage, expectedErrorMessage)
      t.equal(errorType, expectedErrorType)

      const { agentAttributes } = params

      t.ok(agentAttributes.spanId)

      const matchingSpan = agentTesting.findSpanById(helper.agent, agentAttributes.spanId)

      const { attributes, intrinsics } = matchingSpan
      t.equal(intrinsics.name, `${OPERATION_PREFIX}/${UNKNOWN_OPERATION}`)
      t.equal(attributes['error.message'], expectedErrorMessage)
      t.equal(attributes['error.class'], expectedErrorType)
    })

    executeQuery(serverUrl, invalidQuery, (err, result) => {
      t.error(err)

      t.ok(result)
      t.ok(result.errors)
      t.equal(result.errors.length, 1) // should have one parsing error

      const [parseError] = result.errors
      t.equal(parseError.extensions.code, 'GRAPHQL_PARSE_FAILED')

      t.end()
    })
  })

  t.test('validation error should be noticed and assigned to operation span', (t) => {
    const { helper, serverUrl } = t.context

    const expectedErrorMessage = 'Cannot query field "doesnotexist" on type "Book".'
    const expectedErrorType = 'GraphQLError'

    const invalidQuery = `query {
      libraries {
        books {
          doesnotexist {
            name
          }
        }
      }
    }`

    const deepestPath = 'libraries.books.doesnotexist.name'
    const expectedOperationName = `${OPERATION_PREFIX}/query/${ANON_PLACEHOLDER}/${deepestPath}`

    helper.agent.once('transactionFinished', (transaction) => {
      const errorTraces = agentTesting.getErrorTraces(helper.agent)
      t.equal(errorTraces.length, 1)

      const errorTrace = errorTraces[0]

      const [, transactionName, errorMessage, errorType, params] = errorTrace
      t.equal(transactionName, transaction.name)
      t.equal(errorMessage, expectedErrorMessage)
      t.equal(errorType, expectedErrorType)

      const { agentAttributes } = params

      t.ok(agentAttributes.spanId)

      const matchingSpan = agentTesting.findSpanById(helper.agent, agentAttributes.spanId)

      const { attributes, intrinsics } = matchingSpan
      t.equal(intrinsics.name, expectedOperationName)
      t.equal(attributes['error.message'], expectedErrorMessage)
      t.equal(attributes['error.class'], expectedErrorType)
    })

    executeQuery(serverUrl, invalidQuery, (err, result) => {
      t.error(err)

      t.ok(result)
      t.ok(result.errors)
      t.equal(result.errors.length, 1) // should have one parsing error

      const [validationError] = result.errors
      t.equal(validationError.extensions.code, 'GRAPHQL_VALIDATION_FAILED')

      t.end()
    })
  })

  t.test('resolver error should be noticed and assigned to resolve span', (t) => {
    const { helper, serverUrl } = t.context

    const expectedErrorMessage = 'Boom goes the dynamite!'
    const expectedErrorType = 'Error'

    const expectedName = 'BOOM'
    const invalidQuery = `query ${expectedName} {
      boom
    }`

    const expectedResolveName = `${RESOLVE_PREFIX}/boom`

    helper.agent.once('transactionFinished', (transaction) => {
      const errorTraces = agentTesting.getErrorTraces(helper.agent)
      t.equal(errorTraces.length, 1)

      const errorTrace = errorTraces[0]

      const [, transactionName, errorMessage, errorType, params] = errorTrace
      t.equal(transactionName, transaction.name)
      t.equal(errorMessage, expectedErrorMessage)
      t.equal(errorType, expectedErrorType)

      const { agentAttributes } = params

      t.ok(agentAttributes.spanId)

      const matchingSpan = agentTesting.findSpanById(helper.agent, agentAttributes.spanId)

      const { attributes, intrinsics } = matchingSpan
      t.equal(intrinsics.name, expectedResolveName)
      t.equal(attributes['error.message'], expectedErrorMessage)
      t.equal(attributes['error.class'], expectedErrorType)
    })

    executeQuery(serverUrl, invalidQuery, (err, result) => {
      t.error(err)

      t.ok(result)
      t.ok(result.errors)
      t.equal(result.errors.length, 1) // should have one parsing error

      const [resolverError] = result.errors
      t.equal(resolverError.extensions.code, 'INTERNAL_SERVER_ERROR')

      t.end()
    })
  })

  const errorTests = [
    {
      type: 'UserInputError',
      code: 'BAD_USER_INPUT',
      name: 'userInputError',
      msg: 'user input error'
    },
    {
      type: 'ValidationError',
      code: 'GRAPHQL_VALIDATION_FAILED',
      name: 'validationError',
      msg: 'validation error'
    },
    { type: 'ForbiddenError', code: 'FORBIDDEN', name: 'forbiddenError', msg: 'forbidden error' },
    { type: 'SyntaxError', code: 'GRAPHQL_PARSE_FAILED', name: 'syntaxError', msg: 'syntax error' },
    { type: 'AuthenticationError', code: 'UNAUTHENTICATED', name: 'authError', msg: 'auth error' }
  ]

  errorTests.forEach(({ type, code, name, msg }) => {
    t.test(type, (t) => {
      const { helper, serverUrl } = t.context

      const expectedErrorMessage = msg
      const expectedErrorType = type

      const invalidQuery = `query ${name} {
        ${name}
      }`

      helper.agent.once('transactionFinished', (transaction) => {
        const errorTraces = agentTesting.getErrorTraces(helper.agent)
        t.equal(errorTraces.length, 1)

        const errorTrace = errorTraces[0]

        const [, transactionName, errorMessage, errorType, params] = errorTrace
        t.equal(transactionName, transaction.name)
        t.equal(errorMessage, expectedErrorMessage)
        t.equal(errorType, expectedErrorType)

        const { agentAttributes, userAttributes } = params

        t.ok(agentAttributes.spanId)
        t.equal(userAttributes.code, code)

        const matchingSpan = agentTesting.findSpanById(helper.agent, agentAttributes.spanId)

        const { attributes } = matchingSpan
        t.equal(attributes['error.message'], expectedErrorMessage)
        t.equal(attributes['error.class'], expectedErrorType)
      })

      executeQuery(serverUrl, invalidQuery, (err, result) => {
        t.error(err)
        t.ok(result)
        t.ok(result.errors)
        t.equal(result.errors.length, 1) // should have one parsing error

        const [resolverError] = result.errors
        t.equal(resolverError.extensions.code, code)
        t.end()
      })
    })
  })

  t.test('Invalid operation name should not crash server', (t) => {
    const { helper, serverUrl } = t.context
    const query = 'query Hello { hello }'
    const expectedErrorMessage = 'Unknown operation named "testMe".'
    const expectedErrorType = 'GraphQLError'

    helper.agent.once('transactionFinished', (transaction) => {
      const errorTraces = agentTesting.getErrorTraces(helper.agent)
      t.equal(errorTraces.length, 1)

      const errorTrace = errorTraces[0]

      const [, transactionName, errorMessage, errorType, params] = errorTrace
      t.equal(transactionName, transaction.name)
      t.equal(errorMessage, expectedErrorMessage)
      t.equal(errorType, expectedErrorType)

      const { agentAttributes } = params

      t.ok(agentAttributes.spanId)

      const matchingSpan = agentTesting.findSpanById(helper.agent, agentAttributes.spanId)

      const { attributes } = matchingSpan
      t.equal(attributes['error.message'], expectedErrorMessage)
      t.equal(attributes['error.class'], expectedErrorType)
    })
    const data = JSON.stringify({ query, operationName: 'testMe' })
    makeRequest(serverUrl, data, (err, result) => {
      t.error(err)
      t.ok(result)
      t.ok(result.errors)
      t.equal(result.errors.length, 1) // should have one parsing error
      const [resolverError] = result.errors
      // in apollo 4 they added a first class code for invalid oepration names
      const expectedCode = isApollo4 ? 'OPERATION_RESOLUTION_FAILURE' : 'INTERNAL_SERVER_ERROR'
      t.equal(resolverError.extensions.code, expectedCode)
      t.equal(resolverError.message, expectedErrorMessage)
      t.end()
    })
  })
}

module.exports = {
  suiteName: 'errors',
  createTests: createErrorTests
}

/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const NOTICED_ERRORS = Symbol('New Relic Noticed Errors')

class ErrorHelper {
  isValidRequestContext(instrumentationApi, requestContext) {
    if (!requestContext || !requestContext.errors || !Array.isArray(requestContext.errors)) {
      instrumentationApi.logger.trace('didEncounterErrors received malformed arguments, skipping')
      return false
    }
    return true
  }

  addErrorsFromApolloRequestContext(instrumentationApi, requestContext) {
    if (!this.isValidRequestContext(instrumentationApi, requestContext)) {
      return
    }

    for (const error of requestContext.errors) {
      if (!isErrorNoticed(error, requestContext)) {
        this.noticeError(instrumentationApi, error)
      }
    }
  }

  noticeError(instrumentationApi, error) {
    error = error.originalError || error
    const transaction = instrumentationApi.tracer.getTransaction()
    instrumentationApi.agent.errors.add(transaction, error, error.extensions)
  }
}

function isErrorNoticed(error, requestContext) {
  if (!error.originalError || !requestContext[NOTICED_ERRORS]) {
    return false
  }

  return requestContext[NOTICED_ERRORS].indexOf(error.originalError) >= 0
}

ErrorHelper.NOTICED_ERRORS = NOTICED_ERRORS

module.exports = ErrorHelper

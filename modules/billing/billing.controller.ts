import type { RequestHandler } from "express";

import { sendSuccess } from "../../shared/utils/api-response.js";
import * as billingService from "./billing.service.js";

export const getSubscription: RequestHandler = async (req, res, next) => {
  try {
    const result = await billingService.getBillingOverview(
      req.workspace!.id,
      req.workspace!.role,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const getSubscriptionPaymentStatus: RequestHandler = async (req, res, next) => {
  try {
    const result = await billingService.getSubscriptionPaymentStatus(req.workspace!.id);
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const createSubscription: RequestHandler = async (req, res, next) => {
  try {
    const result = await billingService.createSubscription(
      req.workspace!.id,
      req.user!.id,
      req.body,
    );
    sendSuccess(res, 201, result);
  } catch (error) {
    next(error);
  }
};

export const changePlan: RequestHandler = async (req, res, next) => {
  try {
    const result = await billingService.changePlan(
      req.workspace!.id,
      req.user!.id,
      req.body,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const cancelSubscription: RequestHandler = async (req, res, next) => {
  try {
    const result = await billingService.cancelSubscription(req.workspace!.id);
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const createSetupIntent: RequestHandler = async (req, res, next) => {
  try {
    const result = await billingService.createSetupIntent(req.workspace!.id, req.user!.id);
    sendSuccess(res, 201, result);
  } catch (error) {
    next(error);
  }
};

export const listPaymentMethods: RequestHandler = async (req, res, next) => {
  try {
    const result = await billingService.listPaymentMethods(req.workspace!.id);
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const attachPaymentMethod: RequestHandler = async (req, res, next) => {
  try {
    const result = await billingService.attachPaymentMethod(
      req.workspace!.id,
      req.user!.id,
      req.body.paymentMethodId,
    );
    sendSuccess(res, 201, result);
  } catch (error) {
    next(error);
  }
};

export const setDefaultPaymentMethod: RequestHandler = async (req, res, next) => {
  try {
    const result = await billingService.setDefaultPaymentMethod(
      req.workspace!.id,
      req.body.paymentMethodId,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

export const removePaymentMethod: RequestHandler = async (req, res, next) => {
  try {
    await billingService.removePaymentMethod(req.workspace!.id, req.params.id as string);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

export const listInvoices: RequestHandler = async (req, res, next) => {
  try {
    const result = await billingService.listInvoices(req.workspace!.id);
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

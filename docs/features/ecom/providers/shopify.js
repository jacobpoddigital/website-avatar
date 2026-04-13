/**
 * ecom/providers/shopify.js — Shopify Storefront API provider (stub)
 *
 * Placeholder implementing the normalised ecommerce provider interface for Shopify.
 * All methods throw "not yet implemented" — this file establishes the structure
 * and self-registration so the Shopify provider can be built incrementally.
 *
 * When implemented, this will use the Shopify Storefront API (GraphQL).
 * Requires client KV config: {
 *   "ecomEnabled": true,
 *   "ecomPlatform": "shopify",
 *   "shopifyToken": "<public-storefront-access-token>",
 *   "shopifyStoreDomain": "mystore.myshopify.com"
 * }
 *
 * Note: shopifyToken must be a *public* Storefront API token (read-only, safe on frontend).
 * Never put Admin API keys in client config.
 */

(function () {
  'use strict';

  const WA   = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  const _warn = (...a) => console.warn('[WA:Shopify]', ...a);

  // ── PROVIDER (STUB) ────────────────────────────────────────────────────────

  class ShopifyProvider {
    get platformName() { return 'shopify'; }

    isAvailable() {
      const config = window.WA_CONFIG || {};
      const ready  = !!(config.shopifyToken && config.shopifyStoreDomain);
      if (!ready) {
        _warn('shopifyToken or shopifyStoreDomain missing from config — Shopify unavailable');
      }
      return ready;
    }

    // Stub: all methods throw until implemented
    _notImplemented(method) {
      throw new Error(`ShopifyProvider.${method}() is not yet implemented`);
    }

    async searchProducts()    { this._notImplemented('searchProducts'); }
    async getProduct()        { this._notImplemented('getProduct'); }
    async getCart()           { this._notImplemented('getCart'); }
    async addToCart()         { this._notImplemented('addToCart'); }
    async updateCartItem()    { this._notImplemented('updateCartItem'); }
    async removeCartItem()    { this._notImplemented('removeCartItem'); }
    async applyCoupon()       { this._notImplemented('applyCoupon'); }
    gotoCheckout()            { this._notImplemented('gotoCheckout'); }
  }

  // ── SELF-REGISTER ──────────────────────────────────────────────────────────

  if (WA.EcomFactory) {
    WA.EcomFactory.registerProvider('shopify', ShopifyProvider);
  } else {
    _warn('WA.EcomFactory not found — ecom/index.js must load before providers');
  }

})();

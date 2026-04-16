/**
 * ecom/index.js — Ecommerce action layer
 *
 * Platform-agnostic ecommerce actions for the Website Avatar.
 * Detects the active platform from WA_CONFIG and loads the appropriate provider.
 *
 * Detection is config-driven — never window global sniffing.
 * Client KV config must include: { "ecomEnabled": true, "ecomPlatform": "woocommerce" }
 *
 * Self-registers all ecom_* actions via WA.registerAction() — actions.js is never edited.
 *
 * Load order: after actions.js, before wa-dialogue.js
 */

(function () {
  'use strict';

  const WA = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  const _log = (...a) => WA.DEBUG && console.log('[WA:Ecom]', ...a);
  const _warn = (...a) => console.warn('[WA:Ecom]', ...a);

  // ── PROVIDER REGISTRY ──────────────────────────────────────────────────────

  // Providers register themselves here via EcomFactory.registerProvider()
  const _providers = {};

  const EcomFactory = {
    /**
     * Register a provider class by platform name.
     * Called by each provider file at load time.
     */
    registerProvider(name, ProviderClass) {
      _providers[name] = ProviderClass;
      _log(`Provider registered: "${name}"`);
    },

    /**
     * Return a provider instance based on WA_CONFIG, or null if ecom is disabled.
     * Config-driven — never sniffs window globals.
     */
    getProvider() {
      const config = window.WA_CONFIG || {};
      if (!config.ecomEnabled) {
        _log('Ecom disabled — ecomEnabled not set in config');
        return null;
      }
      const platform = config.ecomPlatform;
      if (!platform) {
        _warn('ecomEnabled is true but ecomPlatform is not set — no provider loaded');
        return null;
      }
      const ProviderClass = _providers[platform];
      if (!ProviderClass) {
        _warn(`No provider registered for platform: "${platform}"`);
        return null;
      }
      _log(`Using provider: "${platform}"`);
      return new ProviderClass();
    }
  };

  // Expose factory so provider files can self-register
  WA.EcomFactory = EcomFactory;

  // ── ACTIVE PROVIDER ────────────────────────────────────────────────────────

  // Resolved lazily on first action call so providers have time to register
  let _provider = null;

  function _getProvider() {
    if (!_provider) {
      _provider = EcomFactory.getProvider();
    }
    return _provider;
  }

  // ── ACTION HELPERS ─────────────────────────────────────────────────────────

  /**
   * Wrap an action handler with standard guard + error handling.
   * Returns a standardised error response if provider unavailable.
   */
  function _action(name, fn) {
    return async function (action) {
      const provider = _getProvider();
      if (!provider) {
        return { error: 'Ecommerce not available on this site', action: name };
      }
      if (!provider.isAvailable()) {
        return { error: `${provider.platformName} API is not reachable`, action: name };
      }
      try {
        return await fn(provider, action.payload || {});
      } catch (err) {
        _warn(`Action "${name}" threw:`, err.message);
        return { error: err.message, action: name };
      }
    };
  }

  // ── ACTION REGISTRATION ────────────────────────────────────────────────────

  /**
   * Register all ecom_* actions via WA.registerAction().
   * Called once all provider files have loaded.
   */
  function _registerActions() {
    if (!WA.registerAction) {
      _warn('WA.registerAction not available — actions.js must load before ecom/index.js');
      return;
    }

    // ecom_product_search — search for products by keyword
    WA.registerAction({
      type: 'ecom_product_search',
      execute: _action('ecom_product_search', async (provider, { query, limit = 5 }) => {
        if (!query) return { error: 'query is required' };
        _log('Product search:', query, `(limit: ${limit})`);
        const products = await provider.searchProducts(query, { limit });
        _queueProductStrip(products.map(p => ({ imageUrl: p.imageUrl, name: p.name, price: p.price })));
        return { products };
      })
    });

    // ecom_add_to_cart — add a product (with optional variant) to the cart
    WA.registerAction({
      type: 'ecom_add_to_cart',
      execute: _action('ecom_add_to_cart', async (provider, { product_id, quantity = 1, variant_id }) => {
        if (!product_id) return { error: 'product_id is required' };
        _log('Add to cart:', product_id, `qty: ${quantity}`, variant_id ? `variant: ${variant_id}` : '');
        const cart = await provider.addToCart(product_id, quantity, variant_id);
        _updateCartContext(cart);
        _queueProductStrip(cart.items.map(i => ({ imageUrl: i.imageUrl, name: i.name, qty: i.qty, price: i.price })));
        return { cart };
      })
    });

    // ecom_view_cart — return current cart contents
    WA.registerAction({
      type: 'ecom_view_cart',
      execute: _action('ecom_view_cart', async (provider) => {
        _log('View cart');
        const cart = await provider.getCart();
        _updateCartContext(cart);
        _queueProductStrip(cart.items.map(i => ({ imageUrl: i.imageUrl, name: i.name, qty: i.qty, price: i.price })));
        return { cart };
      })
    });

    // ecom_update_cart — change quantity of an existing cart item
    WA.registerAction({
      type: 'ecom_update_cart',
      execute: _action('ecom_update_cart', async (provider, { item_key, quantity }) => {
        if (!item_key) return { error: 'item_key is required' };
        if (quantity === undefined || quantity === null) return { error: 'quantity is required' };
        _log('Update cart item:', item_key, `qty: ${quantity}`);
        const cart = await provider.updateCartItem(item_key, quantity);
        _updateCartContext(cart);
        return { cart };
      })
    });

    // ecom_remove_from_cart — remove an item from the cart
    WA.registerAction({
      type: 'ecom_remove_from_cart',
      execute: _action('ecom_remove_from_cart', async (provider, { item_key }) => {
        if (!item_key) return { error: 'item_key is required' };
        _log('Remove cart item:', item_key);
        const cart = await provider.removeCartItem(item_key);
        _updateCartContext(cart);
        return { cart };
      })
    });

    // ecom_apply_coupon — apply a discount code
    WA.registerAction({
      type: 'ecom_apply_coupon',
      execute: _action('ecom_apply_coupon', async (provider, { coupon_code }) => {
        if (!coupon_code) return { error: 'coupon_code is required' };
        _log('Apply coupon:', coupon_code);
        return await provider.applyCoupon(coupon_code);
      })
    });

    // ecom_goto_checkout — navigate to the checkout page
    WA.registerAction({
      type: 'ecom_goto_checkout',
      execute: _action('ecom_goto_checkout', async (provider) => {
        _log('Go to checkout');
        provider.gotoCheckout();
        return { navigating: true };
      })
    });

    _log('All ecom_* actions registered');
  }

  // ── PRODUCT STRIP QUEUE ────────────────────────────────────────────────────

  /**
   * Stash product/cart items for ui.js to render after the next agent message.
   * We can't render immediately because the agent text response hasn't arrived yet.
   */
  function _queueProductStrip(items) {
    if (!items || !items.length) return;
    WA._pendingProductStrip = items.filter(i => i.imageUrl);
    _log('Product strip queued —', WA._pendingProductStrip.length, 'items');
  }

  // ── CART CONTEXT SYNC ──────────────────────────────────────────────────────

  /**
   * After any cart mutation, update the dynamic variables available to the agent.
   * This keeps cart_item_count fresh without requiring the agent to re-fetch.
   */
  function _updateCartContext(cart) {
    if (!cart) return;
    WA._ecomCartContext = {
      cart_item_count: cart.itemCount ?? 0,
      ecom_currency:   cart.currency  ?? '',
    };
    _log('Cart context updated — items:', WA._ecomCartContext.cart_item_count);
  }

  // Expose for wa-dialogue.js to read when building dynamic variables
  WA.getEcomContext = function () {
    const config   = window.WA_CONFIG || {};
    const platform = config.ecomEnabled ? (config.ecomPlatform || null) : null;
    return {
      ecom_platform:    platform,
      cart_item_count:  WA._ecomCartContext?.cart_item_count ?? 0,
      ecom_currency:    WA._ecomCartContext?.ecom_currency   ?? '',
    };
  };

  // ── INIT ───────────────────────────────────────────────────────────────────

  // Register actions immediately — providers have already loaded (they load before this in sequence)
  _registerActions();

  const ecomCtx = WA.getEcomContext();
  _log(`Loaded — platform: "${ecomCtx.ecom_platform || 'none'}", ecomEnabled: ${!!(window.WA_CONFIG || {}).ecomEnabled}`);

})();

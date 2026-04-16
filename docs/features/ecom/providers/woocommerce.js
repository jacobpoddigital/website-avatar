/**
 * ecom/providers/woocommerce.js — WooCommerce Store API provider
 *
 * Implements the normalised ecommerce provider interface for WooCommerce.
 * Uses the WC Store REST API (/wp-json/wc/store/v1/) — same-origin only.
 * Auth: storeApiNonce (from window.wcSettings) + existing WC session cookie.
 * No API keys required — all requests carry credentials: 'include'.
 *
 * Activation: set { "ecomEnabled": true, "ecomPlatform": "woocommerce" } in client KV config.
 */

(function () {
  'use strict';

  const WA   = window.WebsiteAvatar || (window.WebsiteAvatar = {});
  const _log  = (...a) => WA.DEBUG && console.log('[WA:WooCommerce]', ...a);
  const _warn = (...a) => console.warn('[WA:WooCommerce]', ...a);

  // ── PROVIDER ───────────────────────────────────────────────────────────────

  class WooCommerceProvider {
    get platformName() { return 'woocommerce'; }

    /**
     * WooCommerce is available if wcSettings exists and has a storeApiNonce.
     * Config already declared the platform — this is a runtime reachability check.
     */
    isAvailable() {
      const available = !!(window.wcSettings?.storeApiNonce);
      if (!available) {
        _warn('wcSettings.storeApiNonce not found — Store API may not be available on this page');
      }
      return available;
    }

    // ── HELPERS ─────────────────────────────────────────────────────────────

    /**
     * Build base URL for Store API from the current origin.
     * All requests are same-origin — no cross-domain calls.
     */
    _apiBase() {
      return `${window.location.origin}/wp-json/wc/store/v1`;
    }

    /**
     * Read the nonce fresh on every request — WP rotates it periodically.
     */
    _nonce() {
      return window.wcSettings?.storeApiNonce ?? '';
    }

    /**
     * Shared fetch wrapper for Store API requests.
     * Always sends credentials (WC session cookie) and the current nonce.
     */
    async _fetch(path, options = {}) {
      const url     = `${this._apiBase()}${path}`;
      const method  = options.method || 'GET';
      const headers = {
        'Content-Type': 'application/json',
        'Nonce':        this._nonce(),   // WooCommerce Store API nonce (Wordfence strips X-WC-Store-API-Nonce)
        ...(options.headers || {})
      };

      _log(`${method} ${path}`);

      const resp = await fetch(url, {
        method,
        credentials: 'include',   // carry the WC session cookie
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText);
        throw new Error(`Store API ${method} ${path} → ${resp.status}: ${errText}`);
      }

      return resp.json();
    }

    // ── NORMALISATION HELPERS ────────────────────────────────────────────────

    /**
     * Map a WC Store API product object to the normalised Product shape.
     */
    _normaliseProduct(p) {
      return {
        id:          p.id,
        name:        p.name,
        price:       p.prices?.price        ? (parseInt(p.prices.price, 10) / 100).toFixed(2) : '0.00',
        currency:    p.prices?.currency_code ?? '',
        stockStatus: p.stock_status ?? 'unknown',
        description: p.short_description ?? p.description ?? '',
        url:         p.permalink ?? '',
        imageUrl:    p.images?.[0]?.src ?? '',
        variants:    (p.variations ?? []).map(v => ({
          id:        v.id,
          name:      v.attributes?.map(a => a.value).join(' / ') ?? '',
          price:     v.prices?.price ? (parseInt(v.prices.price, 10) / 100).toFixed(2) : '0.00',
          available: v.stock_status === 'instock',
        })),
      };
    }

    /**
     * Map a WC Store API cart response to the normalised Cart shape.
     */
    _normaliseCart(c) {
      return {
        items: (c.items ?? []).map(item => ({
          key:       item.key,
          productId: item.id,
          variantId: item.variation?.length ? item.variation[0].value : null,
          name:      item.name,
          qty:       item.quantity,
          price:     item.prices?.price ? (parseInt(item.prices.price, 10) / 100).toFixed(2) : '0.00',
          imageUrl:  item.images?.[0]?.src ?? '',
        })),
        subtotal:  c.totals?.total_price ? (parseInt(c.totals.total_price, 10) / 100).toFixed(2) : '0.00',
        currency:  c.totals?.currency_code ?? '',
        itemCount: c.items_count ?? 0,
      };
    }

    // ── INTERFACE ────────────────────────────────────────────────────────────

    /**
     * Search products by keyword.
     * GET /wp-json/wc/store/v1/products?search={q}&per_page={n}
     */
    async searchProducts(query, { limit = 5 } = {}) {
      _log('searchProducts:', query, `limit: ${limit}`);
      const params = new URLSearchParams({ search: query, per_page: String(limit) });
      const data   = await this._fetch(`/products?${params}`);
      return data.map(p => this._normaliseProduct(p));
    }

    /**
     * Get a single product by ID.
     * GET /wp-json/wc/store/v1/products/{id}
     */
    async getProduct(id) {
      _log('getProduct:', id);
      const data = await this._fetch(`/products/${id}`);
      return this._normaliseProduct(data);
    }

    /**
     * Get the current cart.
     * GET /wp-json/wc/store/v1/cart
     */
    async getCart() {
      _log('getCart');
      const data = await this._fetch('/cart');
      return this._normaliseCart(data);
    }

    /**
     * Add a product to the cart.
     * POST /wp-json/wc/store/v1/cart/add-item
     */
    async addToCart(productId, qty = 1, variantId = null) {
      _log('addToCart:', productId, `qty: ${qty}`, variantId ? `variant: ${variantId}` : '');
      const body = { id: productId, quantity: qty };
      if (variantId) body.variation = [{ attribute: 'any', value: String(variantId) }];
      const data = await this._fetch('/cart/add-item', { method: 'POST', body });
      return this._normaliseCart(data);
    }

    /**
     * Update the quantity of an existing cart item.
     * POST /wp-json/wc/store/v1/cart/update-item
     */
    async updateCartItem(itemKey, qty) {
      _log('updateCartItem:', itemKey, `qty: ${qty}`);
      const data = await this._fetch('/cart/update-item', {
        method: 'POST',
        body:   { key: itemKey, quantity: qty }
      });
      return this._normaliseCart(data);
    }

    /**
     * Remove an item from the cart.
     * POST /wp-json/wc/store/v1/cart/remove-item
     */
    async removeCartItem(itemKey) {
      _log('removeCartItem:', itemKey);
      const data = await this._fetch('/cart/remove-item', {
        method: 'POST',
        body:   { key: itemKey }
      });
      return this._normaliseCart(data);
    }

    /**
     * Apply a coupon/discount code to the cart.
     * POST /wp-json/wc/store/v1/cart/apply-coupon
     */
    async applyCoupon(code) {
      _log('applyCoupon:', code);
      try {
        const data = await this._fetch('/cart/apply-coupon', {
          method: 'POST',
          body:   { code }
        });
        // WC returns the updated cart on success
        return { success: true, message: `Coupon "${code}" applied`, cart: this._normaliseCart(data) };
      } catch (err) {
        // WC returns 400/409 with a readable message for invalid/already-applied codes
        return { success: false, message: err.message };
      }
    }

    /**
     * Navigate to the WooCommerce checkout page.
     * URL is derived from wcSettings or falls back to /checkout.
     */
    gotoCheckout() {
      const checkoutUrl = window.wcSettings?.checkoutUrl ?? `${window.location.origin}/checkout`;
      _log('gotoCheckout →', checkoutUrl);
      window.location.href = checkoutUrl;
    }
  }

  // ── SELF-REGISTER ──────────────────────────────────────────────────────────

  // Wait for EcomFactory to be available (index.js must load first)
  if (WA.EcomFactory) {
    WA.EcomFactory.registerProvider('woocommerce', WooCommerceProvider);
  } else {
    _warn('WA.EcomFactory not found — ecom/index.js must load before providers');
  }

})();

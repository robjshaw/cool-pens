# Ollie endpoint discovery

Verified on **24 November 2026 (Australia/Sydney)** using the public Officeworks website and a new anonymous session. No logged-in user tokens or browser cookies were copied.

## Verified endpoints

| Method | URL | Result |
| --- | --- | --- |
| POST | `https://www.officeworks.com.au/app/header/api/cart/get-token` | 200; returns `sessionId`, `token`, `expiry`, `token_expiry` |
| POST | `https://agenticapplications.googleapis.com/v1/sales:retrieveConfig` | 401 without auth; 200 with the Officeworks-issued bearer token |
| POST | `https://agenticapplications.googleapis.com/v1/sales:executeChat?alt=sse` | 200, `text/event-stream`; text and structured products |

This is an agent-to-agent HTTP integration with a proprietary Google Commerce AI protocol. It is not evidence of a public partner API, SLA, or A2A-compatible endpoint.

## 1. Obtain an anonymous session

```http
POST /app/header/api/cart/get-token
Host: www.officeworks.com.au
Content-Type: application/json
```

```json
{
  "visitorId": "ow.<new random identifier>",
  "userId": null,
  "state": "W_NSW"
}
```

Use the returned `sessionId` in subsequent token requests to continue the same conversation. Keep the visitor identifier stable for that conversation. The Officeworks client derives the state from its delivery-state selection, defaulting to `W_VIC`; this MVP explicitly configures a state, defaulting to NSW.

The adapter requests a token at each turn, keeps the conversation identifier only in process memory, and does not persist bearer tokens. Each Slack user has a separate anonymous conversation. No account login, personal identifier, or purchase history is supplied.

`OFFICEWORKS_POSTCODE` is optional. When configured, the adapter includes the office state and postcode in the chat text on every turn. No postcode property is added to the token request: the inspected token function only supplies the state. This is conversational location context, not a verified local-stock filter or a saved delivery address.

When Slack office mapping is enabled, the caller can supply a mapped state/postcode per user. That state is used in the token request and both values appear in the chat context. A state or postcode change discards the prior anonymous conversation so its previous location cannot carry over. Unmapped users use the configured defaults. Raw Slack profile fields and other profile data are not sent to these endpoints.

## 2. Retrieve the merchant configuration (discovery)

```http
POST /v1/sales:retrieveConfig
Host: agenticapplications.googleapis.com
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "name": "projects/agentis-commerce-corp-dev/locations/prod/salesAgentConfigs/llsudioqpaq1qjku"
}
```

The route name above is taken from Google’s client code and Officeworks’ public SDK customer ID. The successful response’s `payload.settings.service` is JSON containing `name: "commerce-ai"` and `commerceAiClientId: "OFFICEWORKS"`. The application uses that verified client ID directly; it does not retrieve the UI configuration on every chat turn.

## 3. Send a message and consume SSE

```http
POST /v1/sales:executeChat?alt=sse
Host: agenticapplications.googleapis.com
Authorization: Bearer <token>
Content-Type: application/json
Accept: text/event-stream
X-Timezone: Australia/Sydney
```

```json
{
  "clientId": "OFFICEWORKS",
  "sessionId": "<sessionId from Officeworks>",
  "inputs": [{ "text": "Find two everyday gel pen multipacks. Recommendations only." }]
}
```

The tested response was a sequence of SSE `data:` JSON frames. Text fragments occur at `output.textBlock.item.elements[].text`. Structured products occur at `output.productCollection.products[]`:

- `id`, `name`, `uri`, and `imageUris` identify the product.
- `price.currencyCode`, `price.units`, and `price.nanos` represent money; amount = units + nanos / 1,000,000,000.
- `priceInfo`, `ratingsAndReviews`, `brand`, and `metadata` may also appear.
- Progress messages and turn metadata are separate output types. The application ignores those for the displayed answer.

The live probe returned Paper Mate InkJoy Gel Pens 0.7mm Assorted 10 Pack (`PM1956279`) and Studymate 0.7mm Advanced Gel Ink Retractable Pen 24 Pack (`SM4518C24B`), with Officeworks product URLs. These are evidence of the live exchange, not a fixed catalogue or a current price guarantee.

## Cart boundary

In the website conversation, Ollie said it could add selected products to a basket. Inspection of Officeworks’ frontend shows that Google’s SDK calls retailer-provided `handleCartUpdate` and `handleGetCart` hooks. That functionality depends on a separate Officeworks cart bridge; the chat endpoint alone is not a complete cart or checkout integration.

This MVP does not execute model-generated callbacks. Suggestions become internal cupboard requests. An owner-approved snapshot can now be handed to the native storefront URL below. The older optional Chrome helper uses the separate JSON cart API. Purchases remain on Officeworks.

## Approved-cart API (verified 25 November 2026)

The public header vendor bundle exposes these same-origin operations, using Officeworks browser session cookies:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/app/header/api/cart?_=<timestamp>` | Read cart, including `cartId` and `items[].{itemId,sku,quantity}`; 404 means no cart |
| POST | `/app/header/api/cart/items` | Create a guest cart with its first item |
| POST | `/app/header/api/cart/{cartId}/items` | Add an item to an existing cart |
| PATCH | `/app/header/api/cart/{cartId}/items/{itemId}` | Set quantity (observed in frontend; not required by helper) |
| DELETE | `/app/header/api/cart/{cartId}/items/{itemId}` | Remove an item (used only to clean up the isolated live probe) |

The add payload is `{ "sku": "PM1956279", "quantity": 2, "productType": "STANDARD" }`. Mutation responses can contain an empty `cart` object even on success; always follow with a GET to verify actual contents. The current helper supports standard stationery products. It stops on a missing or rejected product and does not substitute.

Live checks created a fresh anonymous cart with `PM1956279 × 2` and `SM4518C24B × 1`. A repeat import retained exactly those quantities. The probe then emptied its own cart. No user account or purchase was involved. See `scripts/probe-cart.mjs`.

Creating this server-side guest cart does not put it into another browser's session. A transferable server-created session was not established; the native bulk-add URL below instead creates or updates the buyer's own browser cart. Officeworks' checkout frontend also exposes `POST <checkout-api>/guestCart` with an email address, but no email was sent and its restoration link was not verified. The initial implementation used a Chrome helper. The normal MVP flow now uses the native storefront redirect below.

Source: [public header vendor bundle](https://www.officeworks.com.au/app/header/577-14ada5d8d52963732a60.js), module `70033`, with `/app/header/api/cart` configured by the header bundle. These are undocumented website interfaces and hashed asset URLs can change.

## Sources and reproduction

- [Officeworks homepage](https://www.officeworks.com.au/): public SDK customer ID and header chunk loader.
- [Officeworks header module](https://www.officeworks.com.au/app/header/460-fa6440cfe6a5ba861f46.js): token function, anonymous request fields, state behaviour, and cart callbacks. This hashed asset URL may change.
- [Google Commerce AI client](https://www.gstatic.com/cloud/ai/commerce_ai_ui/1.0.0/static.js): configuration and chat routes, headers, request construction, and response handling.
- [Officeworks terms](https://www.officeworks.com.au/information/policies/terms-of-use): identifies Ollie as the Google-powered shopping assistant.

Run `node scripts/probe-ollie.mjs` from the project root to reproduce the token → configuration → recommendation exchange. It requires network access and writes redacted response fixtures to the ignored `research/` directory. Run `npm run ollie -- "your stationery question"` to exercise the actual application adapter.


## Native browser handoff (verified 25 November 2026)

`GET https://www.officeworks.com.au/webapp/wcs/stores/servlet/OrderItemAdd`

Parameters: `storeId=10151`, `catalogId=10551`, `langId=-1`, `orderId=.`, `URL=/app/checkout`, `continue=0`, then `partNumber_1`, `quantity_1`, `partNumber_2`, `quantity_2`, etc. No account ID, session cookies or credentials are embedded in the generated link. Officeworks receives its own browser cookies through ordinary top-level navigation.

Discovery started with the legacy Officeworks help-page scripts, which expose `AjaxOrderChangeServiceItemAdd` and indexed SKU/quantity requests. That AJAX command worked but returned JSON. The standard [HCL Commerce OrderItemAdd command](https://help.hcl-software.com/commerce/9.1.0/developer/refs/rosorderitemadd.html) documents the successful-navigation `URL` parameter. Testing that command on Officeworks returned HTTP 302 to `/app/checkout`, and the same guest session's cart contained exactly the two submitted products and quantities. Follow the Officeworks redirect as received; do not log or reuse the generated `krypto` query value across sessions.

`OrderItemUpdate` with SKU/quantity inputs was also tested: repeating it increased quantities. It does **not** make this flow idempotent. The app uses a per-browser handoff-attempt cookie to skip the add URL on later normal clicks, with an explicit retry page. This does not protect across browsers, deleted cookies, simultaneous first clicks, or direct use of the native add URL.

The route adds quantities to the existing cart; it does not replace unrelated items. HCL documents `continue=0` as rollback-on-error behaviour. A live probe with one valid SKU followed by a deliberately invalid SKU returned HTTP 500 and left the pre-existing cart unchanged; no partial add occurred. Stock shortages and business-account restrictions still need separate validation. No automated substitution or checkout occurs.

Officeworks' [online-order help](https://www.officeworks.com.au/help-centre/online-orders) says login can replace guest items with a previously saved account cart. The user confirmed the approved products appeared in their browser cart with the Chrome helper disabled. Authentication status was not established, and logging in after a guest import remains unverified. This is not an OAuth integration and requires no separate account connection in Cool Pens.

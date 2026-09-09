# Changelog

## [0.5.0](https://github.com/croutonian/with-openapi/compare/with-openapi-v0.4.0...with-openapi-v0.5.0) (2026-09-09)


### Features

* eliminate impossible unmatched branch from contribution type based on config ([ca58d41](https://github.com/croutonian/with-openapi/commit/ca58d4125f6f1acdf4daefe30e2472a48279e0fe))


### Bug Fixes

* **document-types:** drop unmatched branch only when config rules it out ([298b639](https://github.com/croutonian/with-openapi/commit/298b6399244de8e980c991e4463dc3113c5fed69))

## [0.4.0](https://github.com/croutonian/with-openapi/compare/with-openapi-v0.3.0...with-openapi-v0.4.0) (2026-09-08)


### ⚠ BREAKING CHANGES

* remove document, method, body, and validated from ctx.openapi

### Features

* add OpenAPIInterface for typed document projections ([b6c54a4](https://github.com/croutonian/with-openapi/commit/b6c54a49bb4e118cb164e4d0eda3eee54e6c65b7))
* **interface:** add OpenAPIInterface for typed document projections ([21b20e7](https://github.com/croutonian/with-openapi/commit/21b20e72145770828b1ae4624b3bdf4b63edf485))
* replace OpenAPIInterface with defineDocument and typed contributions ([4d4cd83](https://github.com/croutonian/with-openapi/commit/4d4cd83cf268a7089cd9f9efe9dc7853b93cdd45))


### Code Refactoring

* remove document, method, body, and validated from ctx.openapi ([09db83a](https://github.com/croutonian/with-openapi/commit/09db83a8ff01f07267230e95ef50e465bc31b533))

## [0.3.0](https://github.com/croutonian/with-openapi/compare/with-openapi-v0.2.0...with-openapi-v0.3.0) (2026-09-07)


### ⚠ BREAKING CHANGES

* **reference:** with a basePath set, the reference page and the document move under it, and the document no longer nests under the page. Anyone relying on the old locations should set `path` and `documentPath` explicitly; both are still taken literally when given.

### Features

* **reference:** let the advertised document URL differ from the served path ([5f27c5e](https://github.com/croutonian/with-openapi/commit/5f27c5e413fe60c8be08a64ada7e88ea21304a61))
* **rejections:** say whether a 404 missed basePath or the document ([80e3eff](https://github.com/croutonian/with-openapi/commit/80e3eff7ac86da841fa1f80b9224b44de4c2e7ce))


### Bug Fixes

* **reference:** derive the reference defaults from basePath ([12a6238](https://github.com/croutonian/with-openapi/commit/12a62386e5bd2358972c4c3166804682a65f2709))
* wizard read a five-minute-old answer about whether npm had the package ([d277320](https://github.com/croutonian/with-openapi/commit/d277320ccfe55ed289a79e9858dee94417f8344d))

## [0.2.0](https://github.com/croutonian/with-openapi/compare/with-openapi-v0.1.0...with-openapi-v0.2.0) (2026-09-07)


### Features

* add `npm run setup-releases`, a wizard for the release setup ([962bcd3](https://github.com/croutonian/with-openapi/commit/962bcd3724866d77c981c23273cda41cccbaa167))
* **ci:** add release setup wizard and fix CI release/publish flow ([48d7173](https://github.com/croutonian/with-openapi/commit/48d7173267a7d4abf20116f05ded8852f4b925ce))
* derive CORS from the document ([da761fa](https://github.com/croutonian/with-openapi/commit/da761faaced994ee1fef995dc26ae92c83c42207))
* OpenAPI middleware for @supabase/middleware ([872b4d6](https://github.com/croutonian/with-openapi/commit/872b4d69c9b1c3249c6dfe3521e76884d05e833b))
* propagate the document's descriptions into violations ([4bf521d](https://github.com/croutonian/with-openapi/commit/4bf521d1ef99ab8c2eba5bd6df80473088ac60f5))


### Bug Fixes

* check the App is installed even when its secrets already exist ([3a2fd98](https://github.com/croutonian/with-openapi/commit/3a2fd98ba706ea84b3c903e695e1082d0ef755e1))
* the npm stage linked to a token page that does not exist ([6732ef0](https://github.com/croutonian/with-openapi/commit/6732ef09647e02c2fca65d157bc9b16a6ca5b356))

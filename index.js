/**
 * Host half of `dsh-composer-md-preview`.
 *
 * The feature is entirely a browser-side concern: it renders the composer
 * draft as Markdown in a card docked above the input box. Nothing here touches
 * the session log, tools, or model requests, so this module exists only because
 * the Loader row needs a Host plugin to mount. The Client module (`./client`)
 * owns every registration.
 */
export function apply() {}

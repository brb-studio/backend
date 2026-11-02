## MODIFIED Requirements

### Requirement: Marca y tema por barbería
Owner y admin SHALL poder cambiar el nombre, la marca (`instagramUrl` https, `authImage`, `coverImage`, `logo`) y el tema. El tema MUST usar solo los tokens `canvas, surface, card, fg, fg-muted, line, line-strong, glass, sheet, accent, accent-fg, accent-text`, cada uno con un color (hex, nombre, `rgb/hsl/oklch/oklab/color-mix(...)`) o con un par `{ light, dark }`.

#### Scenario: Token de tema desconocido o valor inseguro
- **WHEN** se envía un token fuera de la lista o un valor con `;`, `{` o comillas
- **THEN** la respuesta es 422 `VALIDATION`

/**
 * The chrome every printed rcln document shares — a header naming the clinic on
 * every page, a footer, and "Page 1 of 5".
 *
 * A new document type renders `<PageHeader>` and `<PageFooter>` as the first two
 * children of its sheet and includes `pageRule()` and `chromeStylesheet()` in
 * its stylesheet. It does not restate the geometry: `PAGE` is the one
 * declaration of the paper.
 */

export { PageHeader, PageFooter } from './page-chrome.js';
export { ChromeTemplates, HEADER_TEMPLATE_ID, FOOTER_TEMPLATE_ID } from './template.js';
export {
  PAGE,
  CONTENT_WIDTH_MM,
  HEADER_BAND,
  FOOTER_BAND,
  pageRule,
  chromeStylesheet,
} from './styles.js';
export type { DocumentChrome, DocumentChromeIssuer, DocumentChromeMetaRow } from './types.js';

// Ambient declaration for the `mjml` npm package (v4 ships no bundled types and
// @types/mjml targets v5). We only use the default compile function and its
// error shape, so declare the minimal surface we depend on (§11).
declare module 'mjml' {
  interface MjmlError {
    readonly line: number;
    readonly message: string;
    readonly tagName: string;
    readonly formattedMessage: string;
  }
  interface MjmlOptions {
    readonly validationLevel?: 'strict' | 'soft' | 'skip';
    readonly minify?: boolean;
    readonly keepComments?: boolean;
    readonly beautify?: boolean;
    readonly fonts?: Record<string, string>;
  }
  interface MjmlResult {
    readonly html: string;
    readonly errors: MjmlError[];
  }
  function mjml2html(mjml: string, options?: MjmlOptions): MjmlResult;
  export default mjml2html;
}

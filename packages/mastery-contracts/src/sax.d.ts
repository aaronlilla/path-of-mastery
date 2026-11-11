// The part of sax (https://github.com/isaacs/sax-js, 1.6.x) that buildXml.ts uses. The package ships no types.
declare module 'sax' {
  type Handler<T> = ((value: T) => void) | null;
  export interface SAXParser {
    error: Error | null;
    position: number;
    startTagPosition: number;
    onerror: Handler<Error>;
    onopentag: Handler<{ name: string; local?: string; attributes: Record<string, unknown>; isSelfClosing: boolean }>;
    onclosetag: Handler<string>;
    ontext: Handler<string>;
    oncdata: Handler<string>;
    oncomment: Handler<string>;
    onprocessinginstruction: Handler<{ name: string; body: string }>;
    write(chunk: string): SAXParser;
    close(): SAXParser;
  }
  const sax: { parser(strict: boolean, options?: { xmlns?: boolean; position?: boolean; lowercase?: boolean }): SAXParser };
  export default sax;
}

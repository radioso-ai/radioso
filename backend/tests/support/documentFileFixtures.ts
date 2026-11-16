import { crc32, deflateSync } from "node:zlib";

/** A ZIP archive with every entry stored uncompressed: small, valid, and within the office archive limits. */
export const buildStoredZip = (entries: Record<string, Buffer | string>): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const fileName = Buffer.from(name);
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One body paragraph: its text, its style id, and a picture drawn in it. */
export interface DocxParagraph {
  text?: string;
  styleId?: string;
  image?: { media: string; descr?: string; title?: string };
}

const drawing = (relationshipId: string, image: NonNullable<DocxParagraph["image"]>, id: number): string => {
  const descr = image.descr === undefined ? "" : ` descr="${escapeXml(image.descr)}"`;
  const title = image.title === undefined ? "" : ` title="${escapeXml(image.title)}"`;
  return `<w:r><w:drawing><wp:inline><wp:extent cx="3048000" cy="2286000"/><wp:docPr id="${id}" name="Picture ${id}"${descr}${title}/>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill>`
    + `<a:blip r:embed="${relationshipId}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
};

/**
 * A minimal Word document: the given paragraphs, their pictures as `word/media` files through the
 * document's relationships, and the given paragraph styles (id and name).
 */
export const buildDocx = (input: {
  paragraphs: DocxParagraph[];
  media: Record<string, Buffer>;
  styles?: Array<{ id: string; name: string }>;
}): Buffer => {
  const relationships = Object.keys(input.media).map((media, index) => ({ id: `rIdImage${index + 1}`, media }));
  const relationshipFor = (media: string): string => relationships.find((entry) => entry.media === media)?.id ?? "rIdMissing";
  const body = input.paragraphs.map((paragraph, index) => {
    const style = paragraph.styleId ? `<w:pPr><w:pStyle w:val="${paragraph.styleId}"/></w:pPr>` : "";
    const text = paragraph.text ? `<w:r><w:t xml:space="preserve">${escapeXml(paragraph.text)}</w:t></w:r>` : "";
    const picture = paragraph.image ? drawing(relationshipFor(paragraph.image.media), paragraph.image, index + 1) : "";
    return `<w:p>${style}${picture}${text}</w:p>`;
  }).join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document xmlns:w="${W}" xmlns:r="${OFFICE_RELATIONSHIPS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`
    + ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<w:body>${body}</w:body></w:document>`;
  const documentRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS}">`
    + `<Relationship Id="rIdStyles" Type="${OFFICE_RELATIONSHIPS}/styles" Target="styles.xml"/>`
    + relationships.map((entry) => `<Relationship Id="${entry.id}" Type="${OFFICE_RELATIONSHIPS}/image" Target="${entry.media}"/>`).join("")
    + `</Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}">`
    + (input.styles ?? []).map((style) => `<w:style w:type="paragraph" w:styleId="${style.id}"><w:name w:val="${style.name}"/></w:style>`).join("")
    + `</w:styles>`;
  return buildStoredZip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + `<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>`
      + `<Default Extension="jpeg" ContentType="image/jpeg"/>`
      + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
      + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELATIONSHIPS}">`
      + `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": document,
    "word/_rels/document.xml.rels": documentRelationships,
    "word/styles.xml": styles,
    ...Object.fromEntries(Object.entries(input.media).map(([media, bytes]) => [`word/${media}`, bytes])),
  });
};

/** An image XObject a PDF page paints over the given rectangle (`[a b c d e f]`, the unit square's transform). */
export interface PdfImage {
  width: number;
  height: number;
  /** The stream as stored: a JPEG file for `DCTDecode`, deflated pixel rows for `FlateDecode`. */
  data: Buffer;
  filter?: "DCTDecode" | "FlateDecode";
  colorSpace?: "DeviceRGB" | "DeviceGray";
  /** A stencil mask: one bit per pixel, painted in the fill colour. */
  imageMask?: boolean;
  place?: [number, number, number, number, number, number];
}

export interface PdfPage {
  text?: string;
  /** Text rendering mode 3, as OCR draws the text it lays over a scan. */
  invisibleText?: boolean;
  images?: PdfImage[];
}

/** Deflated rows of one colour, as a `FlateDecode` RGB image stores them. */
export const flatRgb = (width: number, height: number, value = 90): Buffer => deflateSync(Buffer.alloc(width * height * 3, value));

/** A minimal PDF of US Letter pages: Helvetica text and image XObjects, with a correct cross-reference table. */
export const buildPdf = (pages: PdfPage[]): Buffer => {
  const objects: Array<Buffer | string | null> = [];
  const add = (body: Buffer | string): number => objects.push(body);
  const stream = (dictionary: string, data: Buffer): Buffer =>
    Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`), data, Buffer.from("\nendstream")]);
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pagesId = objects.push(null);
  const pageIds = pages.map((page) => {
    const xobjects: string[] = [];
    let content = "";
    (page.images ?? []).forEach((image, index) => {
      const name = `Im${index + 1}`;
      const kind = image.imageMask
        ? "/ImageMask true"
        : `/ColorSpace /${image.colorSpace ?? "DeviceRGB"} /BitsPerComponent 8`;
      const filter = image.filter ? ` /Filter /${image.filter}` : "";
      const id = add(stream(`/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ${kind}${filter}`, image.data));
      xobjects.push(`/${name} ${id} 0 R`);
      content += `q ${(image.place ?? [Math.min(image.width, 400), 0, 0, Math.min(image.height, 300), 72, 300]).join(" ")} cm /${name} Do Q\n`;
    });
    if (page.text) {
      const escaped = page.text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      content += `BT ${page.invisibleText ? "3 Tr " : ""}/F1 12 Tf 72 720 Td (${escaped}) Tj ET\n`;
    }
    const contentId = add(stream("", Buffer.from(content)));
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> /XObject << ${xobjects.join(" ")} >> >> /Contents ${contentId} 0 R >>`);
  });
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  let length = parts[0]?.length ?? 0;
  const offsets = objects.map((body, index) => {
    const offset = length;
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body ?? "null"), Buffer.from("\nendobj\n")]);
    parts.push(part);
    length += part.length;
    return offset;
  });
  const table = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
};

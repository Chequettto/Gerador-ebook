'use strict';

/**
 * bookBuildService.js
 * ---------------------------------------------------------------------------
 * Monta o e-book final em PDF e EPUB a partir dos capítulos já gerados.
 * Portado do arquivo original `ebook-build.server.ts` do projeto, mas SEM
 * exigir login/Supabase — funciona aqui de forma independente, para testes.
 * ---------------------------------------------------------------------------
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { zipSync, strToU8 } = require('fflate');
const crypto = require('crypto');

function sanitize(text) {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2022]/g, '-')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2026]/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
}

function wrap(text, font, size, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    lines.push('');
  }
  return lines;
}

async function buildPdf(input) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(input.title);
  pdf.setAuthor(input.author);
  pdf.setSubject(input.subtitle || '');
  pdf.setCreator('Gerador de E-book');

  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const W = 595.28;
  const H = 841.89;
  const MARGIN = 64;
  const MAX_W = W - MARGIN * 2;

  // Capa
  if (input.coverBytes) {
    const page = pdf.addPage([W, H]);
    try {
      const image =
        input.coverMime === 'image/jpeg'
          ? await pdf.embedJpg(input.coverBytes)
          : await pdf.embedPng(input.coverBytes);
      const scale = Math.max(W / image.width, H / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      page.drawImage(image, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
    } catch {
      page.drawText(sanitize(input.title), { x: MARGIN, y: H / 2, size: 28, font: bold });
    }
  }

  // Folha de rosto
  const titlePage = pdf.addPage([W, H]);
  titlePage.drawText(sanitize(input.title), {
    x: MARGIN,
    y: H - 260,
    size: 30,
    font: bold,
    color: rgb(0.08, 0.08, 0.1),
    maxWidth: MAX_W,
    lineHeight: 36,
  });
  if (input.subtitle) {
    titlePage.drawText(sanitize(input.subtitle), {
      x: MARGIN,
      y: H - 330,
      size: 15,
      font: body,
      color: rgb(0.35, 0.35, 0.4),
      maxWidth: MAX_W,
      lineHeight: 20,
    });
  }
  titlePage.drawText(sanitize(input.author), {
    x: MARGIN,
    y: 120,
    size: 13,
    font: bold,
    color: rgb(0.2, 0.2, 0.25),
  });
  titlePage.drawText('Gerado com o gerador de e-books', {
    x: MARGIN,
    y: 96,
    size: 10,
    font: body,
    color: rgb(0.55, 0.55, 0.6),
  });

  // Capítulos
  for (const chapter of input.chapters) {
    let page = pdf.addPage([W, H]);
    let y = H - MARGIN;

    const headingLines = wrap(sanitize(chapter.title), bold, 20, MAX_W).filter(Boolean);
    for (const line of headingLines) {
      page.drawText(line, { x: MARGIN, y, size: 20, font: bold, color: rgb(0.1, 0.1, 0.12) });
      y -= 28;
    }
    y -= 12;

    for (const line of wrap(sanitize(chapter.content), body, 11.5, MAX_W)) {
      if (y < MARGIN + 40) {
        page = pdf.addPage([W, H]);
        y = H - MARGIN;
      }
      if (line) {
        page.drawText(line, { x: MARGIN, y, size: 11.5, font: body, color: rgb(0.13, 0.13, 0.16) });
      }
      y -= 17;
    }
  }

  return pdf.save();
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEpub(input) {
  const uid = `urn:uuid:${crypto.randomUUID()}`;
  const files = {};

  files['mimetype'] = strToU8('application/epub+zip');
  files['META-INF/container.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  );

  const hasCover = !!input.coverBytes;
  const coverExt = input.coverMime === 'image/jpeg' ? 'jpg' : 'png';
  if (input.coverBytes) files[`OEBPS/cover.${coverExt}`] = input.coverBytes;

  files['OEBPS/style.css'] = strToU8(
    `body{font-family:Georgia,serif;line-height:1.6;margin:1.2em;color:#1a1a1a}
h1{font-size:1.6em;margin:0 0 .8em}p{margin:0 0 1em;text-align:justify}`
  );

  const chapterFiles = input.chapters.map((chapter) => {
    const name = `OEBPS/chap-${chapter.position}.xhtml`;
    const paragraphs = chapter.content
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join('\n');
    files[name] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeHtml(chapter.title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><h1>${escapeHtml(chapter.title)}</h1>${paragraphs}</body></html>`
    );
    return { id: `chap${chapter.position}`, href: `chap-${chapter.position}.xhtml`, title: chapter.title };
  });

  if (hasCover) {
    files['OEBPS/cover.xhtml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Capa</title></head>
<body style="margin:0"><img src="cover.${coverExt}" alt="Capa" style="width:100%"/></body></html>`
    );
  }

  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    hasCover
      ? `<item id="cover-image" href="cover.${coverExt}" media-type="image/${coverExt === 'jpg' ? 'jpeg' : 'png'}" properties="cover-image"/>
<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`
      : '',
    ...chapterFiles.map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`),
  ]
    .filter(Boolean)
    .join('\n');

  const spine = [
    hasCover ? `<itemref idref="cover"/>` : '',
    ...chapterFiles.map((c) => `<itemref idref="${c.id}"/>`),
  ]
    .filter(Boolean)
    .join('\n');

  files['OEBPS/content.opf'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${uid}</dc:identifier>
<dc:title>${escapeHtml(input.title)}</dc:title>
<dc:creator>${escapeHtml(input.author)}</dc:creator>
<dc:language>pt-BR</dc:language>
${input.subtitle ? `<dc:description>${escapeHtml(input.subtitle)}</dc:description>` : ''}
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
</metadata>
<manifest>${manifest}</manifest>
<spine>${spine}</spine>
</package>`
  );

  files['OEBPS/nav.xhtml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Sumário</title></head>
<body><nav epub:type="toc"><h1>Sumário</h1><ol>
${chapterFiles.map((c) => `<li><a href="${c.href}">${escapeHtml(c.title)}</a></li>`).join('\n')}
</ol></nav></body></html>`
  );

  return zipSync(files, { level: 6 });
}

module.exports = { buildPdf, buildEpub };

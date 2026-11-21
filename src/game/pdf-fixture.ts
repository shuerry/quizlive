/**
 * Test-only: build tiny valid PDFs in memory.
 * Each page is either lines of text (Helvetica) or, with `null`, a page with a
 * filled rectangle and no text at all, which is what a scanned page looks like to a text extractor.
 */

const enc = new TextEncoder()

function esc(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

export function makePdf(pages: (string[] | null)[]): Uint8Array {
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids: number[] = []
  for (const lines of pages) {
    const stream =
      lines === null
        ? '0.5 g 50 50 495 742 re f'
        : ['BT', '/F1 11 Tf', '50 790 Td', '14 TL', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n')
    objs.push(`<< /Length ${enc.encode(stream).length} >>\nstream\n${stream}\nendstream`)
    const contentId = objs.length
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
    )
    kids.push(objs.length)
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((body, i) => {
    offsets.push(enc.encode(out).length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = enc.encode(out).length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return enc.encode(out)
}

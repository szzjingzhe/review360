import { ServiceUnavailableException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const pending = new Map<string, Promise<Buffer>>();
const office = new Set(['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx']);

/** Called only after the original file's existing authorization check succeeds. */
export async function renderMaterialPreview(file: { buffer: Buffer; fileName: string; mime: string }) {
  const extension = extname(file.fileName).toLowerCase();
  if (!office.has(extension)) return file;
  const hash = createHash('sha256').update(extension).update(file.buffer).digest('hex');
  let work = pending.get(hash);
  if (!work) {
    if (pending.size >= 2) throw new ServiceUnavailableException({ code: 'PREVIEW_BUSY' });
    work = convert(file.buffer, extension);
    pending.set(hash, work);
  }
  try { return { buffer: await work, fileName: parse(file.fileName).name + '.pdf', mime: 'application/pdf' }; }
  finally { if (pending.get(hash) === work) pending.delete(hash); }
}

async function convert(buffer: Buffer, extension: string) {
  const directory = await mkdtemp(join(tmpdir(), 'review360-preview-'));
  try {
    const profile = join(directory, 'profile');
    await mkdir(join(profile, 'user'), { recursive: true });
    await writeFile(join(profile, 'user', 'registrymodifications.xcu'),
      '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>');
    const source = join(directory, 'material' + extension);
    await writeFile(source, buffer);
    await run(process.env.LIBREOFFICE_BIN || 'libreoffice', [
      '-env:UserInstallation=' + pathToFileURL(profile).href, '--headless', '--nologo', '--nodefault',
      '--norestore', '--convert-to', 'pdf', '--outdir', directory, source,
    ], { timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true });
    const pdf = await readFile(join(directory, 'material.pdf'));
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('INVALID_PREVIEW');
    return pdf;
  } catch { throw new ServiceUnavailableException({ code: 'PREVIEW_CONVERSION_FAILED' }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

/** Only internally generated, escaped HTML; never pass uploaded HTML or remote URLs here. */
export async function renderGrowthPdf(html:string) {
  if(pending.size>=2)throw new ServiceUnavailableException({code:'PREVIEW_BUSY'});
  const key='growth-'+createHash('sha256').update(html).digest('hex');
  const work=pending.get(key)??convert(Buffer.from(html,'utf8'),'.html');pending.set(key,work);
  try{return await work;}finally{if(pending.get(key)===work)pending.delete(key);}
}

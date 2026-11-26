import { BadRequestException } from '@nestjs/common';
import { basename } from 'node:path';

const MIMES: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain; charset=utf-8', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
};

/** Keep the multipart MIME untrusted; derive it from the checked extension/content. */
export function validateMaterialFile(file: { originalname: string; size: number; buffer: Buffer }) {
  const ext = (basename(file.originalname).split('.').pop() ?? '').toLowerCase();
  if (!MIMES[ext]) throw new BadRequestException({ code: 'FILE_TYPE_NOT_ALLOWED' });
  const presentation = ['ppt', 'pptx'].includes(ext);
  if (!file.buffer?.length || file.size !== file.buffer.length ||
    (presentation ? file.size >= 50 * 1024 * 1024 : file.size > 20 * 1024 * 1024))
    throw new BadRequestException({ code: 'FILE_SIZE_INVALID' });
  const buffer = file.buffer;
  let valid = false;
  if (ext === 'pdf') valid = buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'));
  if (['doc', 'ppt', 'xls'].includes(ext)) valid = buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  const part: Record<string, string> = { docx: 'word/document.xml', pptx: 'ppt/presentation.xml', xlsx: 'xl/workbook.xml' };
  if (part[ext]) valid = buffer.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')) &&
    buffer.includes(Buffer.from('[Content_Types].xml')) && buffer.includes(Buffer.from(part[ext]));
  if (['jpg', 'jpeg'].includes(ext)) valid = buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  if (ext === 'png') valid = buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (ext === 'txt') {
    try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); valid = !buffer.includes(0); }
    catch { valid = false; }
  }
  if (!valid) throw new BadRequestException({ code: 'FILE_CONTENT_MISMATCH' });
  return { ext, mime: MIMES[ext] };
}

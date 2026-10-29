import { FieldType } from '@prisma/client';

import { PDF_VIEWER_PAGE_SELECTOR } from '../../constants/pdf-viewer';
import { REVALLE_SIGNATURE_FIELD_DEFAULT, REVALLE_SIGNATURE_FIELD_MIN } from '../../revalle/stamp';

/**
 * Tamanho, em pixels de tela, do campo de assinatura nos editores, proporcional à página renderizada (o carimbo
 * depende do tamanho real no PDF, não dos pixels fixos do upstream). Null para outros tipos ou sem página na tela.
 */
export const getRevalleSignatureFieldPixels = (fieldType: FieldType | null | undefined, kind: 'default' | 'min') => {
  if (fieldType !== FieldType.SIGNATURE || typeof document === 'undefined') {
    return null;
  }

  const $page = document.querySelector(PDF_VIEWER_PAGE_SELECTOR);

  if (!$page) {
    return null;
  }

  const { width, height } = $page.getBoundingClientRect();
  const size = kind === 'min' ? REVALLE_SIGNATURE_FIELD_MIN : REVALLE_SIGNATURE_FIELD_DEFAULT;

  return { width: (width * size.width) / 100, height: (height * size.height) / 100 };
};

import type { ComponentProps } from 'react';
import type { Img as ReactEmailImg } from 'react-email';

export {
  Body,
  Button,
  Column,
  Container,
  Font,
  Head,
  Heading,
  Hr,
  Html,
  // REVALLE: `Img` sai daqui (ver abaixo)
  Link,
  Preview,
  Row,
  render,
  Section,
  Tailwind,
  Text,
} from 'react-email';

// REVALLE: e-mails sem imagem (24/11/2026): `Img` não desenha nada em nenhum modelo (logo, ícones, ilustrações). Imagem
// pesa para o Gmail mandar o e-mail para "Promoções"; a marca vai em texto (`RevalleWordmark`).
export const Img = (_props: ComponentProps<typeof ReactEmailImg>) => null;

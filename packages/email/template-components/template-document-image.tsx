import { Column, Img, Row, Section } from '../components';
import { getEmailAssetUrl } from '../utils/asset-url';

export interface TemplateDocumentImageProps {
  assetBaseUrl: string;
  className?: string;
}

export const TemplateDocumentImage = ({ assetBaseUrl, className }: TemplateDocumentImageProps) => {
  return (
    <Section className={className}>
      <Row className="table-fixed">
        <Column />

        <Column>
          {/* REVALLE: alt RevSign */}
          <Img className="mx-auto h-42" src={getEmailAssetUrl(assetBaseUrl, 'static/document.png')} alt="RevSign" />
        </Column>

        <Column />
      </Row>
    </Section>
  );
};

export default TemplateDocumentImage;

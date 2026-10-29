import { REVALLE_TERM_NOTICE, REVALLE_TERM_VERSION } from '@documenso/lib/revalle/term';

export function meta() {
  return [{ title: 'Política de privacidade · RevSign' }];
}

export default function PrivacidadePage() {
  return (
    <article className="mx-auto w-full max-w-3xl space-y-6 text-foreground">
      <header className="space-y-2">
        <h1 className="font-semibold text-3xl">Política de privacidade</h1>
        <p className="text-muted-foreground text-sm">
          {REVALLE_TERM_NOTICE} Versão {REVALLE_TERM_VERSION} — 29/10/2026
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="font-semibold text-xl">Quem é o responsável pelos seus dados</h2>
        <p>
          O responsável (controlador) pelos dados tratados no RevSign, o sistema de assinatura eletrônica da empresa, é
          a Revalle. Razão social, CNPJ e endereço: [a preencher pela Revalle].
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold text-xl">Quais dados usamos</h2>
        <p>Ao assinar um documento, registramos:</p>
        <ul className="list-disc space-y-1 pl-6">
          <li>seu nome, e-mail, CPF, matrícula, cargo, setor e unidade;</li>
          <li>a confirmação da sua data de nascimento, quando for necessária para confirmar que você é colaborador;</li>
          <li>endereço IP, dispositivo e navegador;</li>
          <li>data e hora de cada etapa;</li>
          <li>localização aproximada pelo IP e, se você autorizar, a localização do seu aparelho.</li>
        </ul>
        <p>
          Não coletamos nada além disso. A data de nascimento só é usada para conferir; não é guardada no documento.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold text-xl">Para que usamos</h2>
        <p>
          Usamos esses dados apenas para comprovar a sua identidade e a integridade do documento, ou seja, para provar
          que foi você quem assinou e que o documento não foi alterado depois. Não usamos para publicidade nem para
          outras finalidades.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold text-xl">Base legal</h2>
        <p>O tratamento se apoia na Lei Geral de Proteção de Dados (LGPD, Lei 13.709/2018):</p>
        <ul className="list-disc space-y-1 pl-6">
          <li>art. 7º, II: cumprimento de obrigação legal ou regulatória;</li>
          <li>art. 7º, V: execução de contrato ou de procedimentos ligados a um contrato do qual você é parte;</li>
          <li>art. 10: legítimo interesse da Revalle em comprovar a autoria e a integridade das assinaturas.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold text-xl">Com quem compartilhamos</h2>
        <p>
          Não compartilhamos seus dados com terceiros, exceto quando a lei ou uma ordem de autoridade competente exigir.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold text-xl">Por quanto tempo guardamos</h2>
        <p>
          Guardamos os dados enquanto o documento assinado for necessário para a Revalle e pelos prazos que a lei
          exigir. Depois disso, eles são apagados ou anonimizados.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold text-xl">Segurança</h2>
        <p>
          Usamos medidas técnicas e administrativas para proteger os dados: acesso restrito, comunicação protegida e
          registro das ações feitas no sistema. O CPF aparece mascarado nos registros internos.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold text-xl">Seus direitos</h2>
        <p>
          Conforme o art. 18 da LGPD, você pode pedir à Revalle: confirmação de que tratamos seus dados, acesso,
          correção de dados incompletos ou desatualizados, anonimização, bloqueio ou eliminação de dados desnecessários,
          informações sobre compartilhamento e esclarecimentos sobre os efeitos de não concordar. Também pode reclamar à
          Autoridade Nacional de Proteção de Dados (ANPD).
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold text-xl">Contato</h2>
        <p>
          Para exercer seus direitos ou tirar dúvidas, escreva para{' '}
          <a className="underline" href="mailto:projetos.ti@revalle.com.br">
            projetos.ti@revalle.com.br
          </a>
          .
        </p>
      </section>
    </article>
  );
}

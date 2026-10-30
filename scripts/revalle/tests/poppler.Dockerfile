# Imagem das ferramentas do poppler (pdftotext, pdfinfo, pdfimages, pdffonts) usada por helpers.poppler.
# Construída uma vez como revsign-test-poppler:local; os testes não instalam pacote a cada chamada.
FROM alpine:3.22
RUN apk add --no-cache poppler-utils

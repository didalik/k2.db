# db/public/requestor/Makefile -- `make` (or `make requestor`) here starts {{{1
# Dream Big's Requester. Self-contained: this directory (db/public --
# the k2.db repo, cloned on its own, no k2 monorepo, no other submodule)
# plus `npm i` here is everything it needs.
####

PK ?= GASLAH2RWXX5SJGWCPRDKC67EWMEC4OY4ACXG4RS7O4TGXS2V3XVFJ3K
DB_LOCAL_PORT ?= 8099
DB_REMOTE_PORT ?= 8099
DB_STATUS_PORT ?= 8443

.DEFAULT_GOAL := requestor

.PHONY: requestor # {{{1
requestor:
	@echo $@ started on $$(date)
	DB_TM_ISSUER_PK='${PK}' \
	DB_LOCAL_PORT='${DB_LOCAL_PORT}' \
	DB_REMOTE_PORT='${DB_REMOTE_PORT}' \
	DB_STATUS_PORT='${DB_STATUS_PORT}' \
	node run.js
	echo $@ DONE;echo

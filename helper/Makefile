WINEGCC ?= winegcc
OUT ?= build

$(OUT)/nlbridge.exe: nlbridge.c | $(OUT)
	$(WINEGCC) -O2 -Wall -o $@ $< -lws2_32

$(OUT):
	mkdir -p $@

clean:
	rm -rf $(OUT)

.PHONY: clean

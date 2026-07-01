package marketrules

import (
	"io"
	"net/http"
	"os"
	"testing"
	"time"
)

func TestLiveBEISnapshotContract(t *testing.T) {
	baseURL := os.Getenv("BEI_INTEGRATION_URL")
	token := os.Getenv("BEI_INTEGRATION_TOKEN")
	if baseURL == "" || token == "" {
		t.Skip("live BEI integration environment not configured")
	}
	fetch := func(path string) []byte {
		request, err := http.NewRequest(http.MethodGet, baseURL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("x-service-token", token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("%s returned %d", path, response.StatusCode)
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	resolver, err := NewSnapshotResolver(
		fetch("/public/securities"),
		fetch("/integration/mats/rules"),
		fetch("/public/fee-schedule"),
		time.Now().UTC(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := resolver.LotSize("BARA"); !ok {
		t.Fatal("seeded BARA active lot rule missing")
	}
}

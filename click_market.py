
new_tab("http://localhost:5173/dashboard")
wait_for_load()
js("""
  const links = Array.from(document.querySelectorAll("a, div, span, button"));
  const target = links.find(el => el.textContent.trim() === "Pasar Saham");
  if (target) {
    target.click();
  } else {
    console.error("Pasar Saham not found");
  }
""")
wait_for_load()
capture_screenshot("E:\\_BELAJAR PROGRAMMING_\\github\\Mandala-Exchange\\pasar_saham_2.png")
print(page_info())


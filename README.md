# fabframe — cắm dispatcher vào là chạy

Khung chạy mô phỏng nhà máy bán dẫn **SMT2020** (HVLM, LVHM). Bạn chỉ viết **một
file dispatcher**; khung lo phần còn lại: dựng nhà máy, chạy mô phỏng, gọi dispatcher
mỗi khi có máy rảnh, kiểm tra an toàn, tính KPI và ghi kết quả.

Kernel là bản copy nguyên byte của PySCFabSim-release đã gia cố (bản Paper 4 dùng),
khoá bằng SHA-256. Chỉ dùng thư viện chuẩn Python, không cần numpy/torch.

## Cài đặt (một lần)

```powershell
cd "D:\điều phối\fabframe"
uv venv --python 3.11 .venv
uv pip install --python .venv\Scripts\python.exe pytest
$env:PYTHONIOENCODING = "utf-8"
.venv\Scripts\python.exe -m fabframe verify
```

Nếu `uv` chưa có trong PATH của terminal, mở terminal mới hoặc dùng
`$env:USERPROFILE\.local\bin\uv.exe`.

## Giao diện web

```powershell
cd "D:\điều phối\fabframe"
.venv\Scripts\python.exe -m fabframe ui
```

Trình duyệt mở `http://127.0.0.1:8780/`:

- **Nhà máy 3D** chiếm màn hình: mọi máy SMT2020 xếp theo khu (hai hàng hai bên lối đi).
  Máy có hình dáng theo loại: litho = scanner cao + track thấp, Dry Etch / Dielectric / Thin
  Film = máy cụm (buồng trung tâm + 3 buồng xử lý), Wet Etch = bàn ướt có dãy bể, Diffusion =
  lò đứng có vành gia nhiệt, Implant = hộp nguồn + nam châm + beamline, CMP = đĩa mài dưới nắp
  kính, máy đo = thân gọn có đầu quang học. Mặt trước mỗi máy có EFEM (robot chạy sau cửa kính
  khi máy làm việc, màn hình sáng), hai cổng nạp và tháp đèn. Chi tiết nhỏ chỉ hiện khi lại gần.
  FOUP chờ nằm trên kệ trước mỗi khu (số trên kệ = số lot chờ), lot ở trạm trễ nằm trong stocker
  giữa lối đi; cổng **VÀO** / **XONG**.
- **Lot đi vào máy thế nào:** xe OHT chạy trên ray trần **một chiều** như OHT thật: vòng quanh
  lối đi (ray sau chạy sang phải, ray trước sang trái), mỗi khu có nhánh vào ở đầu này, nhánh
  ra ở đầu kia, ray trên kệ và trên mỗi hàng cổng nạp, cộng một ray quay về cho chuyến trong
  cùng khu. Xe lấy FOUP từ kệ của khu, thả dây hạ FOUP xuống cổng nạp **đúng lúc máy bắt đầu**
  xử lý lot; FOUP nằm trên cổng suốt thời gian máy giữ lot (kể cả setup, hỏng giữa chừng; máy
  nhận lot mới khi lot cũ chưa xong thì hai lot nằm ở hai cổng). Máy xong thì xe nhấc FOUP lên,
  chở tới kệ của khu kế tiếp (trạm trễ: vào stocker; xong quy trình: ra cổng XONG). Mọi xe chạy
  cùng tốc độ và xếp hàng sau nhau, không đi xuyên qua nhau. Chuyến đi gắn với đồng hồ replay:
  dừng thì xe đứng yên, tua lùi thì xe chạy lùi; tua chậm (×1 … 1p/s) và lại gần một khu (bấm
  đúp) để xem rõ từng xe. Rê chuột vào máy: `2 lot → DRY ETCH` = số lot đang ở máy và khu lot
  mới nhất sẽ đi tiếp. Đây là minh hoạ: kernel SMT2020 chuyển lot sang bước sau ngay lập tức,
  không mô phỏng thời gian vận chuyển, nên có lúc một lot vừa được chở đi vừa được chở tới.
  Như fab 300 mm hiện đại, chỉ có OHT: nó vừa chở lot giữa các khu, vừa hạ FOUP xuống tận cổng
  nạp của máy (không có AGV dưới sàn).
- Màu trạng thái nằm ở nóc và phần thân trên của máy (phần thân dưới giữ màu trắng thiết bị):
  nóc trắng = **bận**, nóc đen + thân xám = **rảnh**, vàng = **setup**, xanh dương kẻ lưới =
  **bảo trì** (định kỳ, hoặc theo số wafer ở cuối lượt gia công), đỏ sọc đen = **hỏng**. Các
  màu khác nhau cả về độ sáng nên người mù màu vẫn phân biệt được; tháp đèn 4 tầng (từ dưới
  lên: bảo trì, bận, setup, hỏng) và dải đèn trước máy cũng theo trạng thái. Chưa mở lần chạy
  nào thì máy màu trắng, đèn tắt.
- Kéo để xoay, cuộn để phóng to, bấm đúp vào một khu để lại gần, ⌂ để về góc ban đầu (camera
  bay mượt, kéo chuột giữa chừng thì dừng); rê chuột vào máy hoặc kệ để xem chi tiết. Lần đầu
  mở replay trong phiên có một đoạn bay giới thiệu ~5 giây từ cổng VÀO dọc lối đi (bấm chuột
  hoặc nhấn phím để bỏ qua). Khi đang phát, đèn tháp của máy hỏng nhấp nháy, máy bảo trì "thở".
- Ánh sáng: khu Litho / Litho Met dưới đèn vàng như phòng quang khắc thật (máy bận vẫn màu kem,
  không lẫn với setup). Nút ✦ đổi chất lượng hình (Cao / Vừa / Nhẹ); máy chậm thì tự hạ một bậc
  trong phiên đó.
- **Tua theo ý mình** (thanh dưới): về đầu, lùi / tiến 1 giờ (Shift: 1 ngày), ▶ / ⏸, kéo
  thời gian. Bấm ô tốc độ ⚡ để mở thẻ tốc độ: tên mức (Thời gian thực, Chậm, Vừa, Nhanh, Rất
  nhanh, Siêu tốc) và tốc độ chính xác, kéo thanh trượt lớn từ ×1 đến 1 ngày mỗi giây, ↺ về
  mặc định (30 phút mỗi giây, phát tiến). Bấm tên mức để mở thêm: chiều phát (tiến / lùi), gõ
  số + đơn vị, hoặc bấm nhanh ×1 · 1p · 10p · 1h · 6h · 1n. Phím tắt: Space phát/dừng, ← →
  lùi/tiến 1 giờ (Shift: 1 ngày), ↑ ↓ nhân/chia đôi tốc độ, Home / End về đầu / cuối.
- Bảng bên phải: chọn luật — 8 luật Paper 4 (FIFO mặc định, xem mục dưới) và nhóm **Của tôi**
  cho dispatcher bạn viết (`</>` xem/sửa code, `+` viết mới, `✓` kiểm tra nhanh), HVLM/LVHM,
  số ngày, seed, ▶ **Chạy**. Lần chạy xong tự mở trong 3D; biểu tượng 📊 ở mỗi
  lần chạy mở biểu đồ, bảng, code đã chạy và nhật ký. Trong ô code: Tab thụt lề, Shift+Tab
  hoặc Esc rồi Tab để rời ô, Ctrl+S để lưu.
- Địa chỉ `…/#t=2.5` mở replay tại ngày 2,5 (dừng); `#t=2.5&play` thì phát luôn;
  `#bay=Litho` phóng vào một khu. Liên kết chỉ áp cho replay mở đầu tiên.

Mỗi lần chạy nằm trong `runs\ui\<mã>\` (yêu cầu, bản chụp code, kết quả, tiến độ, replay,
nhật ký), nên sửa dispatcher sau này không làm đổi hồ sơ lần chạy cũ. Replay của giao diện ghi
tối đa 60 ngày đầu (khoảng 0,6 MB mỗi ngày với HVLM); nếu lần chạy dài hơn, giao diện báo
phần đã ghi. Máy đang bận hoặc hỏng lúc hết warm-up được mang sang đầu replay. Trạng thái
máy trong 3D khớp với trạng thái kernel báo, kể cả khi tua lùi rồi phát tiếp
(`tests/test_replay.py`). Giao diện chỉ mở trên máy này (127.0.0.1) và có token phiên, vì nó
chạy được code Python. Dừng bằng Ctrl+C.

## Luật có sẵn: bộ luật Paper 4

Đúng bộ luật cổ điển của Paper 4 (FabResilienceLab, `GraphRule` trong
`policies/paper4_experts.py`), cùng mã, cùng thứ tự D1…D8, cộng cận dưới ngẫu nhiên:

| Mã (dòng lệnh) | Tên | Paper 4 | Xếp lot theo |
|---|---|---|---|
| `fifo` | FIFO | D1, mặc định | ít setup → ưu tiên cao → sẵn sàng sớm → hạn sớm (trùng FIFO của kernel) |
| `critical-ratio` | CR | D2 | ít setup → ưu tiên cao → tỷ số tới hạn nhỏ (trùng CR của kernel) |
| `atc` | ATC | D4, k = 2 | chỉ số ATC lớn → hạn sớm → đã qua ít bước |
| `srpt` | SRPT | D5 | số wafer × thời gian gia công còn lại nhỏ → hạn sớm → đã qua ít bước |
| `atc-cqt` | ATC-CQT | D6 | ít setup → ưu tiên cao → như ATC |
| `srpt-cqt` | SRPT-CQT | D7 | ít setup → ưu tiên cao → như SRPT |
| `cqt-savable-first` | CQT-savable-first | D8 | như FIFO, nhưng lot còn kịp hạn CQT đi trước lot đã quá hạn CQT |
| `uniform` | Uniform | cận dưới | ngẫu nhiên đều, RNG riêng theo seed (không đổi sự cố của nhà máy) |

- Chỉ số ATC = ưu tiên / p × e^(−max(0, hạn − bây giờ − p) / (k × p̄)), với p là thời gian
  gia công trung bình của bước, p̄ là trung bình p trên các bước Paper 4 cho chọn ở máy này
  (bước có đủ số lot tối thiểu của batch; đang chạy minimum-run thì chỉ các bước cùng setup).
  Tính bằng số thực thường như Paper 4: lot còn xa hạn có chỉ số về 0 và khi đó xếp theo hạn.
  Đổi k bằng `-o k=3` (giao diện: ô tham số); kết quả ghi tên `ATC (k=3)`.
- Paper 4 chọn cả batch (mỗi bước là một ứng viên); fabframe chấm từng lot rồi kernel ghép
  batch, nên hạn, ưu tiên, việc còn lại của batch thành của chính lot đó. Mọi luật ở đây đứng
  sau hai chốt của kernel (hợp minimum-run trước, lot đang có CQT trước), kể cả ATC và SRPT
  vốn không có hai chốt này trong Paper 4. Không có D3 minimum-batch: chọn batch theo kích
  thước là việc bộ chọn của kernel tự làm (batch đầy hơn trước), điểm của từng lot không
  diễn đạt được.
- `tests/test_rules.py` kiểm thứ tự của từng luật khớp khoá Paper 4 (chép từ
  `paper4_experts.py`) trên lot ngẫu nhiên; FIFO và CR còn trùng kernel từng lần dispatch.

## Viết một dispatcher

```python
# examples/priority_minus_cr.py
from fabframe import Dispatcher

class PriorityMinusCR(Dispatcher):
    name = "priority-minus-cr"

    def score(self, lot, decision):
        # Điểm CAO chạy TRƯỚC. Có thể trả một số, hoặc một tuple so sánh từ trái sang phải.
        return lot.priority - lot.cr
```

Đây là luật tự viết duy nhất Paper 4 từng chạy (`P4-HEADROOM-SYMBOLIC-PRIORITY-MINUS-CR-v1`):
ưu tiên trừ tỷ số tới hạn. Nút `+` trong giao diện cũng bắt đầu từ luật này.

Hoặc chỉ một hàm:

```python
def score(lot, decision):
    return lot.priority - lot.cr
```

Nếu cần khởi tạo một lần (đọc model, tính bảng tra...), viết thêm
`def setup(self, fab):` — `fab` có `dataset`, `seed`, `days`, `machine_families`, `machines`.
Tham số của hàm khởi tạo truyền bằng `-o ten=gia_tri` trên dòng lệnh.

### Dispatcher nhìn thấy gì

`lot` (một lot đang chờ máy này; thời gian tính bằng **giây**):

| Trường | Ý nghĩa |
|---|---|
| `id`, `product`, `part` | mã lot, loại lot (tên đơn hàng SMT2020), mã sản phẩm |
| `priority` | độ ưu tiên, lớn hơn = quan trọng hơn |
| `release_at`, `due` | thời điểm phát hành, hạn giao (tuyệt đối) |
| `ready_since`, `waiting` | bắt đầu chờ từ khi nào, đã chờ bao lâu |
| `step_name`, `step_index`, `family` | bước hiện tại, số thứ tự bước, họ máy |
| `setup_needed`, `setup_time` | setup bước này cần; thời gian setup **nếu chạy trên máy này** |
| `batch_min`, `batch_max` | giới hạn batch (số lot); 1 = không batch |
| `step_time`, `remaining_time` | thời gian gia công trung bình của bước này / của mọi bước còn lại |
| `steps_done`, `steps_left` | số bước đã xong / còn lại sau bước này |
| `cr`, `slack` | critical ratio; `due - now - remaining_time` |
| `cqt_active`, `cqt_left` | có cửa sổ CQT đang chạy không; còn bao nhiêu giây (âm = đã quá) |

`decision`: `now`, `day`, `machine` (`id`, `family`, `group`, `setup`, `min_runs_left`,
`min_runs_setup`, `cascading`), `candidates` (tất cả lot đang chờ, cùng kiểu với `lot`),
`wip`, `completed`.

Mọi thứ là **bản sao chỉ đọc**; dispatcher không chạm được vào simulator.

### Khung làm gì với điểm của bạn

Thứ tự cuối cùng là `(hợp minimum-run trước, lot đang có CQT trước, điểm của bạn)`.
Sau đó **bộ chọn của kernel** ghép batch, chuyển sang máy cùng họ đã có đúng setup nếu
có, và giữ luật minimum-run. Dispatcher chỉ quyết định thứ tự trong phần còn lại.

## Chạy

```powershell
.venv\Scripts\python.exe -m fabframe list                                          # luật có sẵn
.venv\Scripts\python.exe -m fabframe run critical-ratio --days 30                  # chạy một luật Paper 4
.venv\Scripts\python.exe -m fabframe check examples\priority_minus_cr.py           # thử nhanh, báo lỗi ngay
.venv\Scripts\python.exe -m fabframe run examples\priority_minus_cr.py --days 30   # chạy thật
.venv\Scripts\python.exe -m fabframe run atc -o k=3 --dataset LVHM --days 30 --seed 2
```

| Tuỳ chọn | Mặc định | |
|---|---|---|
| `--dataset` | `HVLM` | `HVLM` hoặc `LVHM` |
| `--days` | 7 | số ngày tính KPI |
| `--seed` | 0 | kịch bản ngẫu nhiên của nhà máy |
| `--warmup-days` | 0 | chạy FIFO trước, không tính KPI |
| `--rng` | `semantic` | xem mục đảm bảo; `legacy` = RNG gốc của kernel |
| `--strict` | tắt | dừng ngay khi dispatcher lỗi thay vì dùng FIFO dự phòng |
| `--out` | `runs\<tên>_<dataset>_seed<s>_<n>d.json` | file kết quả |
| `--ledger` | tắt | ghi từng quyết định ra JSONL (file lớn) |

Tốc độ: khoảng 4 giây cho mỗi ngày mô phỏng HVLM với luật đơn giản.

Từ Python:

```python
from fabframe import run
result = run("examples/priority_minus_cr.py", dataset="HVLM", days=30, seed=0)
print(result.kpi["throughput_per_day"], result.kpi["on_time_rate"])
```

## Kết quả

| KPI | Ý nghĩa |
|---|---|
| `lots_completed`, `throughput_per_day` | số lot hoàn tất trong kỳ đo |
| `on_time_rate` | tỉ lệ lot hoàn tất đúng hạn |
| `mean_cycle_time_days` | thời gian từ phát hành đến hoàn tất, trung bình |
| `mean_tardiness_hours` | độ trễ hạn trung bình trên lot hoàn tất |
| `cqt_violations` | số lần vi phạm thời gian chờ CQT |
| `moves`, `moves_per_day` | số bước gia công hoàn tất |
| `setups`, `setup_share` | số lần đổi setup; phần thời gian máy dùng cho setup |
| `busy_share` | phần thời gian máy bận (ghi nhận lúc dispatch) |
| `wip_end` | số lot còn trong nhà máy cuối kỳ |
| `per_product` | các chỉ số trên theo từng loại lot |

Kèm theo: số quyết định, số lần dùng FIFO dự phòng và lý do, thời gian dispatcher chạy.

## Khung đảm bảo gì

- **Không làm sai mô phỏng.** FIFO và CR chạy qua khung trùng **từng lần dispatch,
  từng mốc thời gian** với vòng lặp gốc của kernel (`tests/test_equivalence.py`).
- **Dispatcher lỗi không làm sập mô phỏng.** Ngoại lệ, điểm NaN, sai kiểu, cố sửa dữ
  liệu → quyết định đó dùng FIFO và được ghi lại. `--strict` / `check` thì dừng và báo.
- **Đổi dispatcher không đổi "số phận" nhà máy.** Ở chế độ `semantic`, thời điểm hỏng
  máy, thời gian sửa, thời gian gia công được xác định theo sự kiện (máy nào, lot nào,
  lần thứ mấy) chứ không theo thứ tự rút số ngẫu nhiên. Cùng seed → cùng sự cố với
  mọi dispatcher (`tests/test_semantic_rng.py`).
- **Kernel không bị sửa.** Mọi file kernel và dữ liệu được kiểm SHA-256 mỗi lần chạy.

Chạy toàn bộ test: `.venv\Scripts\python.exe -m pytest` (khoảng 2 phút).

## Cấu trúc

```
fabframe/
  api.py          Dispatcher, LotView, MachineView, DecisionView — thứ bạn dùng
  runner.py       vòng mô phỏng, kiểm tra điểm, dự phòng FIFO
  kpi.py          tính KPI
  rng.py          RNG theo sự kiện
  loader.py       nạp dispatcher từ tên / file / module
  dispatchers/    bộ luật Paper 4: fifo, critical-ratio, atc, srpt, atc-cqt, srpt-cqt,
                  cqt-savable-first, uniform
  kernel/         simulator + dữ liệu SMT2020 (không sửa; xem PROVENANCE.md)
  ui/             giao diện web (server.py + static/)
  cli.py
examples/         priority_minus_cr.py (luật tự viết của Paper 4, làm mẫu)
my_dispatchers/   dispatcher bạn viết trong giao diện
docs/             luong-he-thong.drawio — sơ đồ luồng hệ thống (mở bằng extension draw.io)
runs/             kết quả (không đưa vào git)
tests/
```

## Giới hạn hiện tại (v0.1)

- Dispatcher chỉ **xếp thứ tự lot** cho máy đang rảnh. Ghép batch, chọn máy trong họ và
  luật minimum-run vẫn do kernel làm. Muốn dispatcher quyết định cả những việc đó cần
  mở rộng API.
- Chưa có lưu sẵn trạng thái nhà máy đã làm nóng; `--warmup-days` chạy lại mỗi lần.
- Dispatcher AI (torch...) chạy được nếu bạn tự cài thư viện vào `.venv`; khung không
  quản lý model.
- Chỉ là mô phỏng SMT2020; không có dữ liệu hay kết nối nhà máy thật (MES).
- Folder cũ `tool mô phỏng bán dẫn` là kho lưu trữ; fabframe không đọc gì từ đó.

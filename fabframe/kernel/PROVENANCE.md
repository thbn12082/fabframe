# Nguồn gốc kernel

Kernel mô phỏng trong thư mục này là **bản copy nguyên byte**, không sửa, của phần
lõi `simulation/` trong `PySCFabSim-release` (MIT, xem `LICENSE-PySCFabSim`).

| | |
|---|---|
| Nguồn | `D:\điều phối\tool mô phỏng bán dẫn\PySCFabSim-release` |
| Git upstream | `0dbff6a` + các chỉnh sửa có kiểm soát P2 (RNG theo ngữ nghĩa) và P3A (horizon cố định) của Paper 4 |
| Ngày copy | 2026-09-29 |
| Dữ liệu | `datasets/SMT2020_HVLM`, `datasets/SMT2020_LVHM` (benchmark SMT2020 công khai) |

Bảy file lõi khớp đúng SHA-256 đã được Paper 4 duyệt
(`FabResilienceLab/src/fab_resilience/adapters/simulator/pyscfabsim_exogenous.py`,
`APPROVED_SOURCE_SHA256`):

```
f8964c48a61d3a3aecc2eecba72b2a2d47333b31998e61469058c98bb1f3067f  simulation/randomizer.py
7481cd71648a0413148d791747d0de0ccf711b877a628c2be9bb37077d574197  simulation/tools.py
c6e63d4bb93d623fca81172930f8cc4651ee51a1a7e6b2ed1701eb51cef26a42  simulation/classes.py
4422961bee182730eed40904084167606ea94227aba555108aa1ac2d7b8166e9  simulation/file_instance.py
f6b638611f3df2c1120c73f0fe64354dc7f78590184c56efde56575f399e5bd2  simulation/instance.py
2d7499392b14ad0e9b1bb7f75e8fa86acaecaea47198b9a7573418b95560aa3d  simulation/events.py
c071a054343216734ae447973f03a845a33a55a776c5a38775c2f6fd87e8f0d5  simulation/dispatching/dispatcher.py
```

Không copy: `simulation/gym/` (RL, cần numpy/gym/torch), các plugin replay/chart/wandb,
`scenario.py`. Lõi còn lại chỉ dùng thư viện chuẩn của Python.

`MANIFEST.sha256` khoá mọi file trong `vendor/` và `datasets/`. `fabframe.kernel.load()`
kiểm lại toàn bộ trước khi chạy và từ chối nếu có byte nào khác. **Không sửa file
trong thư mục này**; muốn thay kernel thì copy bản mới, tạo lại manifest và ghi lại
ở đây.

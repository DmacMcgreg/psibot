#!/bin/bash

# List of video IDs to check
VIDEO_IDS=(
"JKk77rzOL34" "z58RmqYcX00" "PmcEtMsw5nk" "Fp9w1CIhNUU" "hj9z4r5qcnE"
"PN8PLd_k5vs" "Y8Jh9zx6bJc" "VWngYUC63po" "kGXL_Af-hcg" "kyAVCIJj_aM"
"1a78ge4cB7I" "kMivoKHHkxQ" "3_bgCBP3N_c" "b9pG67bUnGg" "dme7Ir3e2EA"
"IYZ_UrHfNGo" "N_RcSa6z-Bo" "WCLgNOkDSMg" "FvmGIFShz9k" "FX_I7BqxJWA"
"_LNVbHTYKOM" "5_6wG7feK8A" "RJ9OapJw7zw" "6OvkVUkr3DE" "NXtVWJJzFd4"
"KT9td3FJxj8" "I-KoLZOy43k" "2BqOhHcTzeM" "7OHCOFFUamQ" "Ei4fT0bk_ic"
"n2N5ZxyQVPI" "ptCxKIizD9g" "V49yx8Ye38A" "O2um7D1veeY" "lUYuO7M4k_s"
"blxdquyOn1E" "Lg_aUOSLuRo" "UR09nuSxGio" "vf7ol8mpZjk" "yAO28HOS5x4"
"Js-zOaA8czQ" "RPzcGeiNYvk" "BJAab5bH_6Y" "K0Ws647wF-Q" "87kVGDkRmqM"
"N1nOpBXCRH4" "OtEidzV5nNE" "ZejxZGHdAVg" "SmYNK0kqaDI" "5Di6o6zuMLc"
"7l7G34RfG4g" "xdXuycwc-sA" "8Wfim7mDE3Q" "_JbLKhpjw-8" "-aRdX-kZ9g4"
"Mwm2VQU-s9Q" "kkouEaKGsec" "-OnvD9McDt8" "8WWFNv4Glas" "FmXKOSuoMGI"
"bo6UKQEC0T0" "LdX19_rW4Pk" "-x_XQcPUxY0" "EKOU3JWDNLI" "jFzwS7z2418"
"Nd17ZGaoZ58" "wq7wiCW-Bq8" "XSN4uuL3jMg" "vElZDiYhYWg" "npQ2IORdlvU"
"950fbVKFwHM" "GmreRPVWC7c" "m8gnIieakL8" "knVaCNiH-8I" "K2zI68KHZqk"
"_LD7NRSf3o8"
)

cd ~/Documents/2_Code/2026/telegram-claude-code

echo "Checking 76 videos..."
echo ""

PROCESSED=0
UNPROCESSED=0
UNPROCESSED_IDS=()

for vid in "${VIDEO_IDS[@]}"; do
  RESULT=$(sqlite3 data/app.db "SELECT COUNT(*) FROM youtube_videos WHERE video_id = '$vid'")
  if [ "$RESULT" -eq 1 ]; then
    ((PROCESSED++))
  else
    ((UNPROCESSED++))
    UNPROCESSED_IDS+=("$vid")
  fi
done

echo "PROCESSED: $PROCESSED/76"
echo "UNPROCESSED: $UNPROCESSED/76"
echo ""
echo "Unprocessed video IDs:"
printf '%s\n' "${UNPROCESSED_IDS[@]}"

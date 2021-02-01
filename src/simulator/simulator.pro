QT       += core gui widgets opengl

TARGET = simulator
TEMPLATE = app

INCLUDEPATH += $$PWD/simulator/ \
               $$PWD/../../third-party
               $$PWD/../../third-party/imgui
               $$PWD/../../third-party/imgui/glfw

HEADERS  += \
    ca_dll.h \
    $$PWD/../../third-party/imgui/imgui.h \
    $$PWD/../../third-party/imgui/imgui_impl_glfw.h \
    $$PWD/../../third-party/imgui/imconfig.h \
    $$PWD/../../third-party/imgui/imgui_internal.h \
    $$PWD/../../third-party/imgui/glfw/glfw3native.h \
    $$PWD/../../third-party/imgui/stb_textedit.h \
    $$PWD/../../third-party/imgui/stb_rect_pack.h \
    $$PWD/../../third-party/imgui/stb_truetype.h

SOURCES += \
  main.cpp \
  ca_dll.cpp \
  $$PWD/../../third-party/imgui/imgui.cpp \
  $$PWD/../../third-party/imgui/imgui_impl_glfw.cpp \
  $$PWD/../../third-party/imgui/imgui_draw.cpp

LIBS += -lOpenGL32
LIBS += "-L$$PWD/../../third-party/imgui/glfw" -lglfw3dll
DEPENDPATH += "$$PWD/../../third-party/imgui/glfw"

## Copies the standalone folder so that the compilation of CA models has the required files
#CONFIG += file_copies
#COPIES += imgui_files
#imgui_files.files = $$files(StandaloneApplication/*)
#CONFIG(debug, debug|release) {
#  standalone_files.path = $$OUT_PWD/debug/StandaloneApplication
#} else {
#  standalone_files.path = $$OUT_PWD/release/StandaloneApplication
#}
